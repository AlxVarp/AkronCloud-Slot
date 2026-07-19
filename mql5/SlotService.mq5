//+------------------------------------------------------------------+
//| SlotService.mq5 - service that bridges the slot with MT5          |
//|             (no chart required).                                 |
//+------------------------------------------------------------------+
//
// Runs as a #property service, launched by MT5 at terminal startup
// (registered in MQL5/profiles/default/services.ini). No chart
// dependency, no template, no manual attach.
//
// Communicates with the slot's bridge-adapter purely via files in
// MQL5/Files/ so no ZMQ / rpyc / Python runtime is required inside
// wine.
//
// File protocol (all paths under MQL5/Files/):
//
//   MQL5 -> host (events):
//     slot-events.jsonl   one JSON event per line:
//       {"kind":"fill"|"order_state"|"position"|"account",
//        "data":{...},"ts":<epoch_ms>}
//
//   MQL5 -> host (state snapshot, every poll):
//     slot-state.json      full snapshot:
//       {"account":{...},"positions":[...],"orders":[...]}
//
//   host -> MQL5 (commands):
//     slot-cmd.json        single JSON object:
//       {"id":"<uuid>","action":"open"|"close"|"cancel"|"sltp",
//        "payload":{...},"ts":<epoch_ms>}
//
//   MQL5 -> host (responses):
//     slot-resp.jsonl      one JSON per line:
//       {"id":"<uuid>","ok":true|false,"result":{...}|"error":"..."}
//
// Slot-to-MT5 path: bridge-adapter.py watches slot-events.jsonl
// and publishes to ZMQ :5557. Subscribes ZMQ :5556 and writes to
// slot-cmd.json.
//
//+------------------------------------------------------------------+
#property copyright "akroncloud-slot"
#property version   "2.00"
#property service
#property strict  false

#include <Files\File.mqh>
#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\AccountInfo.mqh>
#include <Trade\SymbolInfo.mqh>
#include <Trade\OrderInfo.mqh>

input string  DefaultSymbol       = "EURUSD";
input int     PollSeconds         = 1;
input string  EventsFilePath      = "slot-events.jsonl";
input string  StateFilePath       = "slot-state.json";
input string  CmdFilePath         = "slot-cmd.json";
input string  RespFilePath        = "slot-resp.jsonl";
input int     StartupMarkerWaitMs = 3000;

datetime g_lastPollTime       = 0;
string   g_lastProcessedCmdId  = "";
datetime g_lastCmdMtime       = 0;

int OnStart()
{
   PrintFormat("SlotService: start on %s poll=%ds", _Symbol, PollSeconds);
   // Mark autostart done.
   WriteStartupMarker();
   // Initial snapshot so the slot's adapter has state immediately.
   WriteStateFile();
   g_lastPollTime = TimeCurrent();
   EventSetMillisecondTimer(MathMax(250, PollSeconds * 1000));
   return INIT_SUCCEEDED;
}

void OnTimer()
{
   if(TimeCurrent() - g_lastPollTime >= PollSeconds)
   {
      g_lastPollTime = TimeCurrent();
      TryProcessCommand();
      WriteStateFile();
   }
}

void OnTradeTransaction(const MqlTradeTransaction &trans,
                       const MqlRequest &request,
                       const MqlResult &result)
{
   string kind = "order_state";
   string data = "";

   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
   {
      kind = "fill";
      data = StringFormat(
         "{\"broker_order_id\":\"%I64d\",\"deal\":\"%I64d\",\"deal_type\":%d,\"symbol\":\"%s\",\"qty\":%.8f,\"price\":%.8f}",
         trans.order, trans.deal, trans.deal_type, trans.symbol,
         trans.volume, trans.price);
   }
   else if(trans.type == TRADE_TRANSACTION_HISTORY_ADD)
   {
      kind = "fill";
      data = StringFormat(
         "{\"broker_order_id\":\"%I64d\",\"order\":%d,\"deal\":%I64d,\"symbol\":\"%s\"}",
         trans.order, trans.order_state, trans.deal, trans.symbol);
   }
   else if(trans.type == TRADE_TRANSACTION_ORDER_ADD)
   {
      kind = "order_state";
      data = StringFormat(
         "{\"order_id\":\"%I64d\",\"status\":\"placed\"}", trans.order);
   }
   else if(trans.type == TRADE_TRANSACTION_ORDER_DELETE)
   {
      kind = "order_state";
      data = StringFormat(
         "{\"order_id\":\"%I64d\",\"status\":\"canceled\"}", trans.order);
   }
   else if(trans.type == TRADE_TRANSACTION_ORDER_UPDATE ||
           trans.type == TRADE_TRANSACTION_HISTORY_UPDATE)
   {
      kind = "order_state";
      data = StringFormat(
         "{\"order_id\":\"%I64d\",\"status\":\"updated\"}", trans.order);
   }
   else if(trans.type == TRADE_TRANSACTION_ACCOUNT)
   {
      kind = "account";
      data = "{\"kind\":\"login\"}";
   }
   else
   {
      return;
   }

   string ts = TimeToMs(TimeCurrent());
   string line = "{\"kind\":\"" + kind + "\",\"data\":{" + data + "},\"ts\":" + ts + "}\n";
   AppendLine(MQL5FilesPath() + EventsFilePath, line);
}

string MQL5FilesPath()
{
   string p = TerminalInfoString(TERMINAL_DATA_PATH);
   StringReplace(p, "\\", "/");
   int idx = StringFind(p, "/MQL5");
   if(idx >= 0) p = StringSubstr(p, 0, idx) + "/MQL5/Files";
   return p + "/";
}

string TimeToMs(datetime t)
{
   return IntegerToString((long)((long)t * 1000L));
}

void AppendLine(const string path, const string line)
{
   int h = FileOpen(path, FILE_READ|FILE_WRITE|FILE_CSV|FILE_TXT|FILE_ANSI|FILE_SHARE_READ|FILE_SHARE_WRITE, '\n', CP_UTF8);
   if(h == INVALID_HANDLE) return;
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, line);
   FileClose(h);
}

void WriteStartupMarker()
{
   string path = MQL5FilesPath() + "slot-autostart.done";
   int h = FileOpen(path, FILE_WRITE|FILE_TXT|FILE_ANSI, '\n', CP_UTF8);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, "ok " + TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + "\n");
   FileClose(h);
}

string JsonEscape(string s)
{
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   StringReplace(r, "\n", "\\n");
   StringReplace(r, "\r", "\\r");
   StringReplace(r, "\t", "\\t");
   return r;
}

void WriteStateFile()
{
   string path = MQL5FilesPath() + StateFilePath;
   string json = BuildStateJson();
   string tmp = path + ".tmp";
   int h = FileOpen(tmp, FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON, '\n', CP_UTF8);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, json);
   FileClose(h);
   FileMove(tmp, path, FILE_REWRITE);
}

string BuildStateJson()
{
   string acc = StringFormat(
      "{\"login\":\"%I64d\",\"server\":\"%s\",\"name\":\"%s\",\"currency\":\"%s\","
      "\"balance\":%.2f,\"equity\":%.2f,\"margin\":%.2f,\"free_margin\":%.2f,"
      "\"leverage\":%d,\"trade_allowed\":%s}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoString(ACCOUNT_SERVER),
      JsonEscape(AccountInfoString(ACCOUNT_NAME)),
      AccountInfoString(ACCOUNT_CURRENCY),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      AccountInfoInteger(ACCOUNT_LEVERAGE),
      TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ? "true" : "false"
   );

   string pos = "[";
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      string sym = PositionGetSymbol(ticket);
      int    dir = (int)PositionGetInteger(ticket, POSITION_TYPE);
      double vol = PositionGetDouble(ticket, POSITION_VOLUME);
      double op  = PositionGetDouble(ticket, POSITION_PRICE_OPEN);
      double sl  = PositionGetDouble(ticket, POSITION_SL);
      double tp  = PositionGetDouble(ticket, POSITION_TP);
      if(i < PositionsTotal() - 1) pos += ",";
      pos += StringFormat(
         "{\"id\":\"%I64u\",\"account_id\":\"\",\"instrument\":\"%s\","
         "\"side\":\"%s\",\"qty\":%.8f,\"avg_price\":%.8f,\"sl\":%.8f,\"tp\":%.8f}",
         ticket, JsonEscape(sym), dir == POSITION_TYPE_BUY ? "long" : "short",
         vol, op, sl, tp);
   }
   pos += "]";

   string ords = "[";
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      string sym = OrderGetString(ticket, ORDER_SYMBOL);
      int    type = (int)OrderGetInteger(ticket, ORDER_TYPE);
      int    dir  = (int)OrderGetInteger(ticket, ORDER_DIRECTION);
      double vol  = OrderGetDouble(ticket, ORDER_VOLUME_INITIAL);
      double op   = OrderGetDouble(ticket, ORDER_PRICE_OPEN);
      int    state = (int)OrderGetInteger(ticket, ORDER_STATE);
      if(i < OrdersTotal() - 1) ords += ",";
      string stype;
      if(type == ORDER_TYPE_BUY)        stype = "buy";
      else if(type == ORDER_TYPE_SELL)   stype = "sell";
      else                                stype = "limit";
      ords += StringFormat(
         "{\"id\":\"%I64u\",\"account_id\":\"\",\"instrument\":\"%s\","
         "\"side\":\"%s\",\"type\":\"%s\",\"qty\":%.8f,\"price\":%.8f,\"status\":%d}",
         ticket, JsonEscape(sym),
         dir == ORDER_DIRECTION_BUY ? "buy" : "sell",
         stype, vol, op, state);
   }
   ords += "]";

   return "{\"account\":" + acc + ",\"positions\":" + pos + ",\"orders\":" + ords + "}";
}

void TryProcessCommand()
{
   string path = MQL5FilesPath() + CmdFilePath;
   if(!FileIsExist(path)) return;

   datetime mt = (datetime)FileGetInteger(path, FILE_MODIFY_DATE, true);
   if(mt == g_lastCmdMtime) return;

   int h = FileOpen(path, FILE_READ|FILE_TXT|FILE_ANSI, '\n', CP_UTF8);
   if(h == INVALID_HANDLE) return;
   string body = FileReadString(h, 65536);
   FileClose(h);

   string id      = JsonField(body, "id");
   string action = JsonField(body, "action");
   if(id == "" || id == g_lastProcessedCmdId)
   {
      g_lastCmdMtime = mt;
      return;
   }
   g_lastProcessedCmdId = id;
   g_lastCmdMtime = mt;

   PrintFormat("SlotService: cmd id=%s action=%s", id, action);

   bool ok = false;
   string result = "{\"error\":\"unknown_action\"}";

   if(action == "open")
   {
      string sym   = JsonField(body, "payload.instrument");
      double vol   = StringToDouble(JsonField(body, "payload.qty"));
      double price = StringToDouble(JsonField(body, "payload.price"));
      string side  = JsonField(body, "payload.side");
      int    dir   = ORDER_TYPE_BUY;
      if(side == "sell") dir = ORDER_TYPE_SELL;
      double sl    = StringToDouble(JsonField(body, "payload.sl"));
      double tp    = StringToDouble(JsonField(body, "payload.tp"));
      string comment = id;

      MqlTradeRequest req;
      ZeroMemory(req);
      req.action    = TRADE_ACTION_DEAL;
      req.symbol    = sym;
      req.volume    = vol;
      req.type      = price > 0 ? ORDER_TYPE_LIMIT : ORDER_TYPE_MARKET;
      req.price     = price;
      req.sl        = sl;
      req.tp        = tp;
      req.deviation = 10;
      req.comment   = comment;
      req.type_filling = ORDER_FILLING_FOK;

      MqlTradeResult res;
      ZeroMemory(res);
      ok = OrderSend(req, res);
      if(ok)
         result = "{\"order_id\":\"" + IntegerToString((long)res.order) + "\","
                  + "\"broker_order_id\":\"" + IntegerToString((long)res.order) + "\"}";
      else
         result = "{\"error\":\"" + JsonEscape(res.comment) + "\",\"retcode\":" + IntegerToString(res.retcode) + "}";
   }
   else if(action == "close")
   {
      ulong ticket = (ulong)StringToInteger(JsonField(body, "payload.position_id"));
      if(ticket == 0) ticket = (ulong)StringToInteger(JsonField(body, "payload.ticket"));
      if(ticket == 0)
      { result = "{\"error\":\"missing_ticket\"}"; }
      else if(!PositionSelectByTicket(ticket))
      { result = "{\"error\":\"position_not_found\"}"; }
      else
      {
         MqlTradeRequest req;
         ZeroMemory(req);
         req.action = TRADE_ACTION_DEAL;
         req.position = ticket;
         req.symbol = PositionGetSymbol(ticket);
         req.volume = PositionGetDouble(ticket, POSITION_VOLUME);
         req.type = ORDER_TYPE_MARKET;
         req.deviation = 10;
         MqlTradeResult res;
         ZeroMemory(res);
         ok = OrderSend(req, res);
         result = ok ? ("{\"closed_ticket\":\"" + IntegerToString((long)res.order) + "\"}")
                     : ("{\"error\":\"" + JsonEscape(res.comment) + "\"}");
      }
   }
   else if(action == "cancel")
   {
      ulong ticket = (ulong)StringToInteger(JsonField(body, "payload.order_id"));
      if(ticket == 0) { result = "{\"error\":\"missing_ticket\"}"; }
      else
      {
         ok = OrderDelete(ticket);
         result = ok ? ("{\"canceled\":\"" + IntegerToString((long)ticket) + "\"}")
                     : ("{\"error\":\"cancel_failed\"}");
      }
   }
   else if(action == "sltp")
   {
      ulong ticket = (ulong)StringToInteger(JsonField(body, "payload.position_id"));
      if(ticket == 0) { result = "{\"error\":\"missing_ticket\"}"; }
      else if(!PositionSelectByTicket(ticket)) { result = "{\"error\":\"position_not_found\"}"; }
      else
      {
         MqlTradeRequest req;
         ZeroMemory(req);
         req.action = TRADE_ACTION_SLTP;
         req.position = ticket;
         req.sl = StringToDouble(JsonField(body, "payload.sl"));
         req.tp = StringToDouble(JsonField(body, "payload.tp"));
         MqlTradeResult res;
         ZeroMemory(res);
         ok = OrderSend(req, res);
         result = ok ? ("{\"modified\":\"" + IntegerToString((long)ticket) + "\"}")
                     : ("{\"error\":\"" + JsonEscape(res.comment) + "\"}");
      }
   }

   string resp = "{\"id\":\"" + id + "\",\"ok\":\"" + (ok ? "true" : "false") + "\",\"result\":" + result + "}\n";
   AppendLine(MQL5FilesPath() + RespFilePath, resp);
}

string JsonField(const string body, const string path)
{
   string parts[];
   int n = StringSplit(path, '.', parts);
   if(n <= 0) return "";
   string sub = body;
   for(int i = 0; i < n; i++)
   {
      string key = "\"" + parts[i] + "\"";
      int idx = StringFind(sub, key);
      if(idx < 0) return "";
      int colon = StringFind(sub, ":", idx);
      if(colon < 0) return "";
      int j = colon + 1;
      while(j < StringLen(sub) && (StringGetCharacter(sub,j) == ' ' || StringGetCharacter(sub,j) == '\t')) j++;
      int end = j;
      bool quoted = (StringGetCharacter(sub,j) == '"');
      if(quoted)
      {
         end = j + 1;
         while(end < StringLen(sub) && StringGetCharacter(sub,end) != '"')
         {
            if(StringGetCharacter(sub,end) == '\\') end++;
            end++;
         }
      }
      else
      {
         while(end < StringLen(sub) &&
               StringGetCharacter(sub,end) != ',' &&
               StringGetCharacter(sub,end) != '}' &&
               StringGetCharacter(sub,end) != ' ')
            end++;
      }
      string val = StringSubstr(sub, quoted ? j+1 : j, end - (quoted ? j+1 : j));
      sub = val;
   }
   return sub;
}
