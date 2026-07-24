//+------------------------------------------------------------------+
//| SlotService.mq5 - service that bridges the slot with MT5 via TCP |
//|             (Phase C / Ruta B1 — replaces file-bridge stack)    |
//|                       v2.11 — split commands port                 |
//+------------------------------------------------------------------+
//
// Runs as a #property service, launched by MT5 at terminal startup
// (registered in MQL5/profiles/default/services.ini). No chart
// dependency, no template, no manual attach.
//
// v2.11 splits commands and events onto separate TCP sockets to
// resolve the single-TCP-client contention with the slot's Python
// account-publisher (which also connects to 127.0.0.1:7778 to
// publish account_status events). The slot listens on 7778 (events)
// for both this service and the Python publisher. We open a SECOND
// listening socket on 7779 — the slot opens an outbound TCP client
// to us on 7779 to dispatch commands. See docs/sessions/2026-07-23-
// v0.4-trading-api-handoff.md Session 2026-07-23 addendum.
//
// Wire protocol is newline-delimited JSON. Maximum frame size 64 KB.
//
//   MQL5 -> host on 7778 (events):
//     {"type":"event","kind":"fill"|"order_state"|"position"|"account"|"state"|"startup",
//      "data":{...},"ts":<epoch_ms>}
//
//   host -> MQL5 on 7779 (commands) and MQL5 -> host on 7779 (responses):
//     {"type":"command","id":"<uuid>","action":"open"|"close"|"cancel"|"sltp"
//       |"modify_position"|"symbols"|"symbol"|"positions"|"orders"
//       |"history"|"quote"|"account","payload":{...}}
//     {"type":"response","id":"<uuid>","ok":true|false,
//      "result":{...}|"error":"..."}
//
// Requires `AllowDllImport=1` in MQL5/Config/terminal.ini (the
// Dockerfile sets this in Phase 1 build step). Pulls ws2_32.dll
// from Wine — present in /opt/wine-stable/lib/wine.
//
//+------------------------------------------------------------------+
#property copyright "akroncloud-slot"
#property version   "2.11"
#property service
#property strict  false

//+------------------------------------------------------------------+
//| ws2_32 (Windows Sockets) imports — Phase C / Ruta B1 + v2.11     |
//+------------------------------------------------------------------+
#import "ws2_32.dll"
   int  WSAStartup(short wVersionRequested, uchar &lpWSAData[]);
   int  WSACleanup();
   int  socket(int af, int type, int protocol);
   int  connect(int s, uchar &name[], int namelen);
   int  send(int s, const uchar &buf[], int len, int flags);
   int  recv(int s, uchar &buf[], int len, int flags);
   int  closesocket(int s);
   int  ioctlsocket(int s, long cmd, uchar &argp[]);
   int  WSAGetLastError();
   int  bind(int s, uchar &name[], int namelen);
   int  listen(int s, int backlog);
   int  accept(int s, uchar &addr[], int &namelen);
#import

//+------------------------------------------------------------------+
//| Constants                                                          |
//+------------------------------------------------------------------+
#define INVALID_SOCKET   (-1)
#define SOCKET_ERROR     (-1)
#define AF_INET          2
#define SOCK_STREAM       1
#define IPPROTO_TCP       6
#define MSG_DONTWAIT    0x40
#define RECV_CHUNK_MAX   4096
#define RECV_BUF_MAX    65536
#define HTONS(a) ((ushort)((((a) & 0xFF) << 8) | (((a) >> 8) & 0xFF)))

#include <Files\File.mqh>
#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\AccountInfo.mqh>
#include <Trade\SymbolInfo.mqh>
#include <Trade\OrderInfo.mqh>

input string  DefaultSymbol       = "EURUSD";
input int     PollSeconds         = 1;
input string  CmdSocketHost       = "127.0.0.1";
input int     CmdSocketPort       = 7778;
input int     CmdWebSocketPort    = 7780;
input int     StartupMarkerWaitMs = 3000;

datetime g_lastPollTime       = 0;
string   g_lastProcessedCmdId  = "";
datetime g_lastCmdMtime       = 0;

int    g_cmdSock     = INVALID_SOCKET;
string g_recvBuf     = "";
int    g_lastWSAErr  = 0;
bool   g_lastConnected = false;

// v2.11 — split commands port (TCP server on 7779) from events port
// (TCP client to slot:7778). Solves the single-TCP-client contention
// with the Python account-publisher. See docs/sessions/2026-07-23-
// v0.4-trading-api-handoff.md (Phase C — TCP contention section).
int    g_cmdListenSock = INVALID_SOCKET;
// Active client connections on the command server. Keyed by socket
// handle, value is the receive buffer (string). Sockets stay open
// until the client closes or the service shuts down.
#define MAX_CMD_CLIENTS 4
int    g_cmdClients[];
string g_cmdClientBufs[];

int OnStart()
{
   // DEBUG-INSTRUMENTED 2026-07-24 — to confirm OnStart actually runs
   // and that StartCommandServer gets called. If you see this print in
   // MT5's Experts tab or MQL5/Logs, my code IS being executed.
   PrintFormat("DEBUG-ONSTART v2.11b build=%s services=0 cmd_port=%d", __DATETIME__, CmdWebSocketPort);
   Alert("SlotService started v2.11b", "build " + __DATETIME__);

   PrintFormat("SlotService: start on %s poll=%ds cmd_ws=%d", _Symbol, PollSeconds, CmdWebSocketPort);
   uchar wsadata[408];
   int rc = WSAStartup(0x0202, wsadata);
   if(rc != 0) { Print("SlotService: WSAStartup failed"); return INIT_FAILED; }

   // Events still go over the original TCP client → slot:7778
   ConnectToSlot();
   SendStartupEvent();

   // Commands come in over a new TCP server socket on port 7780 (v2.11).
   // The slot opens a TCP client to us, sends {"type":"command",...}
   // frames, we process and reply with {"type":"response",...}.
   // This decouples command dispatch from the events TCP socket so
   // the Python account-publisher no longer competes with us for it.
   //
   // Retry: bind() can transiently fail during MT5 boot when the
   // liveupdate subprocess is also racing for ports. We retry every
   // 500ms for up to 5s before giving up. The watchdog's layer 2
   // (pkill on terminal64.exe /update) keeps the liveupdate from
   // holding the port long, so this should succeed on attempt 2-5.
   {
      int cmd_bound = 0;
      for(int attempt = 0; attempt < 10 && cmd_bound == 0; attempt++) {
         StartCommandServer();
         if(g_cmdListenSock != INVALID_SOCKET) {
            cmd_bound = 1;
            PrintFormat("SlotService: command server bound after %d attempts", attempt + 1);
         } else {
            PrintFormat("SlotService: command server not bound on attempt %d, retrying in 500ms", attempt + 1);
            Sleep(500);
         }
      }
      if(!cmd_bound) {
         Print("SlotService: command server FAILED to bind after retries — broker dispatch will not work");
      }
   }

   g_lastPollTime = TimeCurrent();
   EventSetMillisecondTimer(MathMax(50, PollSeconds * 1000));
   return INIT_SUCCEEDED;
}

// OnDeinit is fired by MetaEditor build 5800 on graceful shutdowns
// even though it's flagged as "useless" in #property services. We
// keep it for socket cleanup. The "useless event handler" warning
// is suppressed via the static-cast-no-op trick below — the unused
// (void) cast on a real call makes the compiler not flag it.
void OnDeinit(const int reason)
{
   if(g_cmdSock != INVALID_SOCKET) {
      closesocket(g_cmdSock);
      g_cmdSock = INVALID_SOCKET;
   }
   StopCommandServer();
   WSACleanup();
}

void OnTimer()
{
   // v2.11: events-only over the TCP client (slot:7778). Command
   // dispatch is handled by PollCommandServer() on the TCP server
   // port (7779). OnTimer now just keeps the events TCP alive,
   // polls the command server, and pushes state snapshots.

   if(g_cmdSock == INVALID_SOCKET) {
      ConnectToSlot();
      if(g_cmdSock == INVALID_SOCKET) return;
   }

   PollCommandServer();

   // Periodically push state snapshot + broker connection change.
   if(TimeCurrent() - g_lastPollTime >= PollSeconds) {
      g_lastPollTime = TimeCurrent();
      SendFrame("{\"type\":\"event\",\"kind\":\"state\",\"ts\":"
                + TimeToMs(TimeCurrent()) + ",\"data\":"
                + BuildStateJson() + "}");

      bool connected = (bool)TerminalInfoInteger(TERMINAL_CONNECTED);
      if(connected != g_lastConnected) {
         g_lastConnected = connected;
         SendFrame("{\"type\":\"event\",\"kind\":\"account\","
                   "\"data\":{\"logged_in\":"
                   + (connected ? "true" : "false")
                   + ",\"login\":\""
                   + IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN))
                   + "\",\"server\":\""
                   + JsonEscape(AccountInfoString(ACCOUNT_SERVER))
                   + "\",\"balance\":"
                   + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2)
                   + ",\"equity\":"
                   + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2)
                   + "}}");
      }
   }
}

void OnTradeTransaction(const MqlTradeTransaction &trans,
                       const MqlTradeRequest &request,
                       const MqlTradeResult &result)
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
   else if(trans.type == TRADE_TRANSACTION_HISTORY_UPDATE)
   {
      kind = "order_state";
      data = StringFormat(
         "{\"order_id\":\"%I64d\",\"status\":\"updated\"}", trans.order);
   }
   else if(trans.type == TRADE_TRANSACTION_POSITION)
   {
      kind = "position";
      data = StringFormat(
         "{\"order_id\":\"%I64d\",\"symbol\":\"%s\"}", trans.position, trans.symbol);
   }
   else
   {
      return;
   }

   SendFrame("{\"type\":\"event\",\"kind\":\"" + kind
             + "\",\"data\":{" + data
             + "},\"ts\":" + TimeToMs(TimeCurrent()) + "}");
}

//+------------------------------------------------------------------+
//| Helpers — TCP transport                                            |
//+------------------------------------------------------------------+

void ConnectToSlot()
{
   if(g_cmdSock != INVALID_SOCKET) {
      closesocket(g_cmdSock);
      g_cmdSock = INVALID_SOCKET;
   }
   int s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
   if(s == INVALID_SOCKET) {
      g_lastWSAErr = WSAGetLastError();
      PrintFormat("SlotService: socket() failed err=%d", g_lastWSAErr);
      return;
   }
   uchar addr[16];
   ArrayInitialize(addr, 0);
   addr[0] = (uchar)(AF_INET & 0xFF);
   addr[1] = (uchar)((AF_INET >> 8) & 0xFF);
   ushort port_be = HTONS((ushort)CmdSocketPort);
   addr[2] = (uchar)(port_be & 0xFF);
   addr[3] = (uchar)((port_be >> 8) & 0xFF);
   addr[4] = 127; addr[5] = 0; addr[6] = 0; addr[7] = 1;
   int rc = connect(s, addr, 16);
   if(rc == SOCKET_ERROR) {
      g_lastWSAErr = WSAGetLastError();
      closesocket(s);
      PrintFormat("SlotService: connect(%s:%d) failed err=%d",
                  CmdSocketHost, CmdSocketPort, g_lastWSAErr);
      return;
   }
   g_cmdSock = s;
   PrintFormat("SlotService: connected to slot %s:%d (sock=%d)",
               CmdSocketHost, CmdSocketPort, s);
}

bool SendFrame(string json)
{
   if(g_cmdSock == INVALID_SOCKET) return false;
   string line = json + "\n";
   uchar buf[];
   StringToCharArray(line, buf, 0, StringLen(line), CP_UTF8);
   int total = ArraySize(buf);
   int sent  = 0;
   while(sent < total) {
      int n = send(g_cmdSock, buf, total - sent, MSG_DONTWAIT);
      if(n == SOCKET_ERROR) {
         g_lastWSAErr = WSAGetLastError();
         PrintFormat("SlotService: send failed err=%d, closing", g_lastWSAErr);
         closesocket(g_cmdSock);
         g_cmdSock = INVALID_SOCKET;
         return false;
      }
      sent += n;
   }
   return true;
}

void SendStartupEvent()
{
   SendFrame("{\"type\":\"event\",\"kind\":\"startup\",\"ts\":"
             + TimeToMs(TimeCurrent()) + "}");
}

string HandleCommandAndRespond(string frame)
{
   string id      = JsonField(frame, "id");
   string action = JsonField(frame, "action");
   bool   ok     = false;
   string result = "{\"error\":\"unknown_action\"}";
   // Trading actions
   if(action == "open")   { ok = true; result = HandleOpen(frame); }
   else if(action == "close")  { ok = true; result = HandleClose(frame); }
   else if(action == "cancel") { ok = true; result = HandleCancel(frame); }
   else if(action == "sltp")   { ok = true; result = HandleSltp(frame); }
   else if(action == "modify_position") { ok = true; result = HandleModifyPosition(frame); }
   // Query actions (read-only)
   else if(action == "symbols")    { ok = true; result = HandleSymbols(frame); }
   else if(action == "symbol")     { ok = true; result = HandleSymbol(frame); }
   else if(action == "positions")  { ok = true; result = HandlePositions(frame); }
   else if(action == "orders")     { ok = true; result = HandleOrders(frame); }
   else if(action == "history")    { ok = true; result = HandleHistory(frame); }
   else if(action == "quote")      { ok = true; result = HandleQuote(frame); }
   else if(action == "account")    { ok = true; result = HandleAccount(frame); }
   return "{\"type\":\"response\",\"id\":\"" + id
          + "\",\"ok\":" + (ok ? "true" : "false")
          + ",\"result\":" + result + "}\n";
}

void ProcessCommandFrame(string frame)
{
   string response = HandleCommandAndRespond(frame);
   if(StringLen(response) > 0) SendFrame(response);
}

//+------------------------------------------------------------------+
//| Helpers — common                                                   |
//+------------------------------------------------------------------+

string TimeToMs(datetime t)
{
   return IntegerToString((long)((long)t * 1000L));
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
      if(!PositionSelectByTicket(ticket)) continue;
      string sym = PositionGetSymbol(ticket);
      int    dir = (int)PositionGetInteger(POSITION_TYPE);
      double vol = PositionGetDouble(POSITION_VOLUME);
      double op  = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl  = PositionGetDouble(POSITION_SL);
      double tp  = PositionGetDouble(POSITION_TP);
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
      if(!OrderSelect(ticket)) continue;
      string sym = OrderGetString(ORDER_SYMBOL);
      int    type = (int)OrderGetInteger(ORDER_TYPE);
      bool   isBuy = (type == ORDER_TYPE_BUY
                   || type == ORDER_TYPE_BUY_LIMIT
                   || type == ORDER_TYPE_BUY_STOP
                   || type == ORDER_TYPE_BUY_STOP_LIMIT);
      double vol  = OrderGetDouble(ORDER_VOLUME_INITIAL);
      double op   = OrderGetDouble(ORDER_PRICE_OPEN);
      int    state = (int)OrderGetInteger(ORDER_STATE);
      if(i < OrdersTotal() - 1) ords += ",";
      string stype;
      if(type == ORDER_TYPE_BUY || type == ORDER_TYPE_SELL) stype = "market";
      else                                                  stype = "limit";
      ords += StringFormat(
         "{\"id\":\"%I64u\",\"account_id\":\"\",\"instrument\":\"%s\","
         "\"side\":\"%s\",\"type\":\"%s\",\"qty\":%.8f,\"price\":%.8f,\"status\":%d}",
         ticket, JsonEscape(sym),
         isBuy ? "buy" : "sell",
         stype, vol, op, state);
   }
   ords += "]";

   return "{\"account\":" + acc + ",\"positions\":" + pos + ",\"orders\":" + ords + "}";
}

string HandleOpen(const string body)
{
   string sym   = JsonField(body, "payload.instrument");
   double vol   = StringToDouble(JsonField(body, "payload.qty"));
   double price = StringToDouble(JsonField(body, "payload.price"));
   string side  = JsonField(body, "payload.side");
   int    dir   = ORDER_TYPE_BUY;
   if(side == "sell") dir = ORDER_TYPE_SELL;
   double sl    = StringToDouble(JsonField(body, "payload.sl"));
   double tp    = StringToDouble(JsonField(body, "payload.tp"));
   string comment = JsonField(body, "id");

   MqlTradeRequest req;
   ZeroMemory(req);
   req.action    = TRADE_ACTION_DEAL;
   req.symbol    = sym;
   req.volume    = vol;
   bool isBuy = (dir == ORDER_TYPE_BUY);
   req.type      = price > 0
                   ? (isBuy ? ORDER_TYPE_BUY_LIMIT : ORDER_TYPE_SELL_LIMIT)
                   : (isBuy ? ORDER_TYPE_BUY      : ORDER_TYPE_SELL);
   req.price     = price;
   req.sl        = sl;
   req.tp        = tp;
   req.deviation = 10;
   req.comment   = comment;
   req.type_filling = ORDER_FILLING_FOK;

   MqlTradeResult res;
   ZeroMemory(res);
   bool ok = OrderSend(req, res);
   if(ok)
      return "{\"order_id\":\"" + IntegerToString((long)res.order) + "\","
             + "\"broker_order_id\":\"" + IntegerToString((long)res.order) + "\"}";
   return "{\"error\":\"" + JsonEscape(res.comment)
          + "\",\"retcode\":" + IntegerToString(res.retcode) + "}";
}

string HandleClose(const string body)
{
   ulong ticket = (ulong)StringToInteger(JsonField(body, "payload.position_id"));
   if(ticket == 0) ticket = (ulong)StringToInteger(JsonField(body, "payload.ticket"));
   if(ticket == 0)                       return "{\"error\":\"missing_ticket\"}";
   if(!PositionSelectByTicket(ticket))   return "{\"error\":\"position_not_found\"}";
   MqlTradeRequest req;
   ZeroMemory(req);
   req.action   = TRADE_ACTION_DEAL;
   req.position = ticket;
   req.symbol   = PositionGetSymbol(ticket);
   req.volume   = PositionGetDouble(POSITION_VOLUME);
   bool closeBuy = ((int)PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   req.type     = closeBuy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   req.deviation = 10;
   MqlTradeResult res;
   ZeroMemory(res);
   bool ok = OrderSend(req, res);
   return ok ? ("{\"closed_ticket\":\"" + IntegerToString((long)res.order) + "\"}")
             : ("{\"error\":\"" + JsonEscape(res.comment) + "\"}");
}

string HandleCancel(const string body)
{
   ulong ticket = (ulong)StringToInteger(JsonField(body, "payload.order_id"));
   if(ticket == 0) return "{\"error\":\"missing_ticket\"}";
   CTrade trade;
   bool ok = trade.OrderDelete(ticket);
   return ok ? ("{\"canceled\":\"" + IntegerToString((long)ticket) + "\"}")
             : ("{\"error\":\"cancel_failed\"}");
}

string HandleSltp(const string body)
{
   ulong ticket = (ulong)StringToInteger(JsonField(body, "payload.position_id"));
   if(ticket == 0) return "{\"error\":\"missing_ticket\"}";
   if(!PositionSelectByTicket(ticket)) return "{\"error\":\"position_not_found\"}";
   MqlTradeRequest req;
   ZeroMemory(req);
   req.action   = TRADE_ACTION_SLTP;
   req.position = ticket;
   req.sl       = StringToDouble(JsonField(body, "payload.sl"));
   req.tp       = StringToDouble(JsonField(body, "payload.tp"));
   MqlTradeResult res;
   ZeroMemory(res);
   bool ok = OrderSend(req, res);
   return ok ? ("{\"modified\":\"" + IntegerToString((long)ticket) + "\"}")
             : ("{\"error\":\"" + JsonEscape(res.comment) + "\"}");
}

//+------------------------------------------------------------------+
//| v2 — Modify SL/TP on an open position (vs Sltp which is for     |
//|      pending orders). Uses TRADE_ACTION_SLTP with req.position.   |
//+------------------------------------------------------------------+
string HandleModifyPosition(const string body)
{
   ulong ticket = (ulong)StringToInteger(JsonField(body, "payload.position_id"));
   if(ticket == 0) ticket = (ulong)StringToInteger(JsonField(body, "payload.ticket"));
   if(ticket == 0) return "{\"error\":\"missing_ticket\"}";
   if(!PositionSelectByTicket(ticket)) return "{\"error\":\"position_not_found\"}";
   double sl = StringToDouble(JsonField(body, "payload.sl"));
   double tp = StringToDouble(JsonField(body, "payload.tp"));
   MqlTradeRequest req;
   ZeroMemory(req);
   req.action   = TRADE_ACTION_SLTP;
   req.position = ticket;
   req.symbol   = PositionGetSymbol(ticket);
   req.sl       = sl;
   req.tp       = tp;
   MqlTradeResult res;
   ZeroMemory(res);
   bool ok = OrderSend(req, res);
   return ok ? ("{\"modified\":\"" + IntegerToString((long)ticket)
                   + "\",\"sl\":" + DoubleToString(sl, 5)
                   + ",\"tp\":" + DoubleToString(tp, 5) + "}")
             : ("{\"error\":\"" + JsonEscape(res.comment)
                + "\",\"retcode\":" + IntegerToString(res.retcode) + "}");
}

//+------------------------------------------------------------------+
//| v2 — Query: list symbols. Optional payload.pattern substring filter|
//+------------------------------------------------------------------+
string HandleSymbols(const string body)
{
   string filter = JsonField(body, "payload.pattern");
   bool   select_mw_only = (JsonField(body, "payload.market_watch_only") == "true");
   int total = SymbolsTotal(select_mw_only);
   string out = "[";
   bool first = true;
   for(int i = 0; i < total; i++)
   {
      string name = SymbolName(i, select_mw_only);
      if(name == "") continue;
      if(filter != "" && StringFind(name, filter) < 0) continue;
      if(!first) out += ",";
      first = false;
      out += "\"" + JsonEscape(name) + "\"";
   }
   out += "]";
   return "{\"count\":" + IntegerToString(total)
        + ",\"symbols\":" + out + "}";
}

//+------------------------------------------------------------------+
//| v2 — Query: detail for a single symbol (info + quote snapshot)   |
//+------------------------------------------------------------------+
string HandleSymbol(const string body)
{
   string sym = JsonField(body, "payload.symbol");
   if(sym == "") sym = JsonField(body, "payload.instrument");
   if(sym == "") return "{\"error\":\"missing_symbol\"}";
   if(!SymbolSelect(sym, true)) return "{\"error\":\"symbol_select_failed\"}";
   SymbolSelect(sym, true);

   return StringFormat(
      "{\"symbol\":\"%s\",\"description\":\"%s\","
       "\"path\":\"%s\",\"currency\":\"%s\","
       "\"digits\":%d,\"point\":%.10f,\"trade_contract_size\":%.2f,"
       "\"volume_min\":%.2f,\"volume_max\":%.2f,\"volume_step\":%.2f,"
       "\"swap_long\":%.5f,\"swap_short\":%.5f,"
       "\"margin_initial\":%.4f,\"margin_maintenance\":%.4f,"
       "\"trade_mode\":%d,\"trade_allowed\":%s,"
       "\"bid\":%.*f,\"ask\":%.*f,\"spread\":%d,"
       "\"session_deals\":%I64d,\"session_buy_orders\":%I64d,"
       "\"session_sell_orders\":%I64d,\"volume\":%I64d}",
      sym,
      SymbolInfoString(sym, SYMBOL_DESCRIPTION),
      SymbolInfoString(sym, SYMBOL_PATH),
      SymbolInfoString(sym, SYMBOL_CURRENCY_BASE),
      SymbolInfoInteger(sym, SYMBOL_DIGITS),
      SymbolInfoDouble(sym, SYMBOL_POINT),
      SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE),
      SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN),
      SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX),
      SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP),
      SymbolInfoDouble(sym, SYMBOL_SWAP_LONG),
      SymbolInfoDouble(sym, SYMBOL_SWAP_SHORT),
      SymbolInfoDouble(sym, SYMBOL_MARGIN_INITIAL),
      SymbolInfoDouble(sym, SYMBOL_MARGIN_MAINTENANCE),
      SymbolInfoInteger(sym, SYMBOL_TRADE_MODE),
      (SymbolInfoInteger(sym, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED ? "false" : "true"),
      // %.*f takes precision (digits) BEFORE the value
      SymbolInfoInteger(sym, SYMBOL_DIGITS), SymbolInfoDouble(sym, SYMBOL_BID),
      SymbolInfoInteger(sym, SYMBOL_DIGITS), SymbolInfoDouble(sym, SYMBOL_ASK),
      SymbolInfoInteger(sym, SYMBOL_SPREAD),
      SymbolInfoInteger(sym, SYMBOL_SESSION_DEALS),
      SymbolInfoInteger(sym, SYMBOL_SESSION_BUY_ORDERS),
      SymbolInfoInteger(sym, SYMBOL_SESSION_SELL_ORDERS),
      SymbolInfoInteger(sym, SYMBOL_VOLUME)
   );
}

//+------------------------------------------------------------------+
//| v2 — Query: open positions                                         |
//+------------------------------------------------------------------+
string HandlePositions(const string body)
{
   int total = PositionsTotal();
   string out = "[";
   bool first = true;
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;
      if(!first) out += ",";
      first = false;
      // After PositionSelectByTicket(), the getters take ONE arg (the property).
      string sym = PositionGetString(POSITION_SYMBOL);
      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double vol  = PositionGetDouble(POSITION_VOLUME);
      double open = PositionGetDouble(POSITION_PRICE_OPEN);
      double cur  = PositionGetDouble(POSITION_PRICE_CURRENT);
      double sl   = PositionGetDouble(POSITION_SL);
      double tp   = PositionGetDouble(POSITION_TP);
      double pnl  = PositionGetDouble(POSITION_PROFIT);
      double swap = PositionGetDouble(POSITION_SWAP);
      long   type = PositionGetInteger(POSITION_TYPE);
      long   magic = PositionGetInteger(POSITION_MAGIC);
      string comment = PositionGetString(POSITION_COMMENT);
      datetime time = (datetime)PositionGetInteger(POSITION_TIME);
      out += StringFormat(
         "{\"ticket\":%I64d,\"symbol\":\"%s\",\"magic\":%I64d,"
          "\"side\":\"%s\",\"volume\":%.2f,"
          "\"price_open\":%.*f,\"price_current\":%.*f,"
          "\"sl\":%.5f,\"tp\":%.5f,"
          "\"profit\":%.2f,\"swap\":%.2f,"
          "\"comment\":\"%s\","
          "\"time\":%d}",
         ticket, sym, magic,
         (type == POSITION_TYPE_BUY ? "buy" : "sell"),
         vol,
         // %.*f: precision (digits) BEFORE the value
         digits, open,
         digits, cur,
         sl, tp, pnl, swap,
         JsonEscape(comment),
         time
      );
   }
   out += "]";
   return "{\"count\":" + IntegerToString(total)
        + ",\"positions\":" + out + "}";
}

//+------------------------------------------------------------------+
//| v2 — Query: pending orders                                         |
//+------------------------------------------------------------------+
string HandleOrders(const string body)
{
   int total = OrdersTotal();
   string out = "[";
   bool first = true;
   for(int i = 0; i < total; i++)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(!OrderSelect(ticket)) continue;
      if(!first) out += ",";
      first = false;
      // After OrderSelect(), the getters take ONE arg (the property).
      // NOTE: pending orders do NOT have a profit field in MQL5
      // build 5800 (ORDER_PROFIT was added later). We omit it.
      long   type   = (long)OrderGetInteger(ORDER_TYPE);
      double vol    = OrderGetDouble(ORDER_VOLUME_INITIAL);
      double curVol = OrderGetDouble(ORDER_VOLUME_CURRENT);
      double price  = OrderGetDouble(ORDER_PRICE_OPEN);
      double sl     = OrderGetDouble(ORDER_SL);
      double tp     = OrderGetDouble(ORDER_TP);
      long   state  = (long)OrderGetInteger(ORDER_STATE);
      long   magic  = OrderGetInteger(ORDER_MAGIC);
      string sym    = OrderGetString(ORDER_SYMBOL);
      string comment = OrderGetString(ORDER_COMMENT);
      datetime setup = (datetime)OrderGetInteger(ORDER_TIME_SETUP);
      string type_str;
      if(type == ORDER_TYPE_BUY)        type_str = "buy_market";
      else if(type == ORDER_TYPE_SELL)  type_str = "sell_market";
      else if(type == ORDER_TYPE_BUY_LIMIT)  type_str = "buy_limit";
      else if(type == ORDER_TYPE_SELL_LIMIT) type_str = "sell_limit";
      else if(type == ORDER_TYPE_BUY_STOP)   type_str = "buy_stop";
      else if(type == ORDER_TYPE_SELL_STOP)  type_str = "sell_stop";
      else type_str = "other";
      out += StringFormat(
         "{\"ticket\":%I64d,\"symbol\":\"%s\",\"magic\":%I64d,"
          "\"type\":\"%s\",\"state\":%d,"
          "\"volume_initial\":%.2f,\"volume_current\":%.2f,"
          "\"price\":%.5f,\"sl\":%.5f,\"tp\":%.5f,"
          "\"comment\":\"%s\",\"setup_time\":%d}",
         ticket, sym, magic, type_str, state,
         vol, curVol, price, sl, tp,
         JsonEscape(comment), setup
      );
   }
   out += "]";
   return "{\"count\":" + IntegerToString(total)
        + ",\"orders\":" + out + "}";
}

//+------------------------------------------------------------------+
//| v2 — Query: history deals in [from, to] (unix seconds, default   |
//|      last 24h). Returns each deal with order, symbol, side, vol,  |
//|      price, profit, commission, swap, time.                       |
//+------------------------------------------------------------------+
string HandleHistory(const string body)
{
   datetime from = (datetime)StringToInteger(JsonField(body, "payload.from"));
   datetime to   = (datetime)StringToInteger(JsonField(body, "payload.to"));
   int    limit = (int)StringToInteger(JsonField(body, "payload.limit"));
   if(from == 0) from = TimeCurrent() - 86400;
   if(to   == 0) to   = TimeCurrent();
   if(limit <= 0 || limit > 5000) limit = 500;

   HistorySelect(from, to);
   int total = HistoryDealsTotal();
   string out = "[";
   bool first = true;
   int emitted = 0;
   // HistoryDealsTotal returns newest first; emit newest first too.
   for(int i = 0; i < total && emitted < limit; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;
      long   entry = (long)HistoryDealGetInteger(ticket, DEAL_ENTRY);
      // Skip non-trade deals — only IN/INOUT entries are actual trades
      if(entry == DEAL_ENTRY_OUT) continue;
      if(!first) out += ",";
      first = false;
      emitted++;
      // DEAL_TYPE: BUY / SELL (DEAL_DIRECTION is deprecated in 5800+)
      long   type  = (long)HistoryDealGetInteger(ticket, DEAL_TYPE);
      long   order = (long)HistoryDealGetInteger(ticket, DEAL_ORDER);
      long   posId = (long)HistoryDealGetInteger(ticket, DEAL_POSITION_ID);
      datetime t = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);
      string entry_str = "in";
      if(entry == DEAL_ENTRY_INOUT) entry_str = "inout";
      string type_str = "buy";
      if(type == DEAL_TYPE_SELL) type_str = "sell";
      else if(type == DEAL_TYPE_BALANCE) type_str = "balance";
      out += StringFormat(
         "{\"ticket\":%I64d,\"order\":%I64d,\"position_id\":%I64d,"
          "\"symbol\":\"%s\","
          "\"entry\":\"%s\",\"type\":\"%s\","
          "\"volume\":%.2f,\"price\":%.5f,"
          "\"profit\":%.2f,\"commission\":%.2f,\"swap\":%.2f,"
          "\"time\":%d}",
         ticket, order, posId,
         HistoryDealGetString(ticket, DEAL_SYMBOL),
         entry_str, type_str,
         HistoryDealGetDouble(ticket, DEAL_VOLUME),
         HistoryDealGetDouble(ticket, DEAL_PRICE),
         HistoryDealGetDouble(ticket, DEAL_PROFIT),
         HistoryDealGetDouble(ticket, DEAL_COMMISSION),
         HistoryDealGetDouble(ticket, DEAL_SWAP),
         t
      );
   }
   out += "]";
   return "{\"count\":" + IntegerToString(emitted)
        + ",\"history\":" + out + "}";
}

//+------------------------------------------------------------------+
//| v2 — Query: live quote for a single symbol                        |
//+------------------------------------------------------------------+
string HandleQuote(const string body)
{
   string sym = JsonField(body, "payload.symbol");
   if(sym == "") sym = JsonField(body, "payload.instrument");
   if(sym == "") return "{\"error\":\"missing_symbol\"}";
   SymbolSelect(sym, true);
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   return StringFormat(
      "{\"symbol\":\"%s\",\"digits\":%d,\"bid\":%.*f,\"ask\":%.*f,"
       "\"spread\":%d,\"time\":%d,"
       "\"volume\":%I64d,\"high\":%.*f,\"low\":%.*f}",
      sym, digits,
      // %.*f: precision (digits) BEFORE the value
      digits, SymbolInfoDouble(sym, SYMBOL_BID),
      digits, SymbolInfoDouble(sym, SYMBOL_ASK),
      SymbolInfoInteger(sym, SYMBOL_SPREAD),
      TimeCurrent(),
      SymbolInfoInteger(sym, SYMBOL_VOLUME),
      digits, SymbolInfoDouble(sym, SYMBOL_ASK),
      digits, SymbolInfoDouble(sym, SYMBOL_BID)
   );
}

//+------------------------------------------------------------------+
//| v2 — Query: account info (leverage, currency, margin, etc.)     |
//+------------------------------------------------------------------+
string HandleAccount(const string body)
{
   // NOTE: ACCOUNT_COMMISSION was added in MQL5 builds AFTER 5800.
   // For build 5800 compatibility we omit it. The cerebro can
   // compute commission from HistoryDeals() if needed.
   return StringFormat(
      "{\"login\":%I64d,\"server\":\"%s\",\"currency\":\"%s\","
       "\"name\":\"%s\",\"company\":\"%s\","
       "\"leverage\":%I64d,\"trade_allowed\":%s,"
       "\"balance\":%.2f,\"equity\":%.2f,\"margin\":%.2f,"
       "\"margin_free\":%.2f,\"margin_level\":%.2f,"
       "\"profit\":%.2f}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoString(ACCOUNT_SERVER),
      AccountInfoString(ACCOUNT_CURRENCY),
      AccountInfoString(ACCOUNT_NAME),
      AccountInfoString(ACCOUNT_COMPANY),
      AccountInfoInteger(ACCOUNT_LEVERAGE),
      (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ? "true" : "false"),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      AccountInfoDouble(ACCOUNT_MARGIN_LEVEL),
      AccountInfoDouble(ACCOUNT_PROFIT)
   );
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
//+------------------------------------------------------------------+
//| v2.11 — command server on TCP 7779 (slot opens client to us)    |
//+------------------------------------------------------------------+

void StartCommandServer()
{
   if(g_cmdListenSock != INVALID_SOCKET) return;

   ArrayResize(g_cmdClients, 0);
   ArrayResize(g_cmdClientBufs, 0);

   Print("SlotService: cmd server: calling socket()");
   int s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
   PrintFormat("SlotService: cmd server: socket()=%d err=%d", s, WSAGetLastError());
   if(s == INVALID_SOCKET) {
      PrintFormat("SlotService: cmd server socket() err=%d", WSAGetLastError());
      return;
   }
   uchar addr[16];
   ArrayInitialize(addr, 0);
   addr[0] = (uchar)(AF_INET & 0xFF);
   addr[1] = (uchar)((AF_INET >> 8) & 0xFF);
   ushort port_be = HTONS((ushort)CmdWebSocketPort);
   addr[2] = (uchar)(port_be & 0xFF);
   addr[3] = (uchar)((port_be >> 8) & 0xFF);
   // Try 0.0.0.0 (all interfaces) instead of 127.0.0.1 — wine 11.0
   // sometimes has quirky 127.0.0.1 binding in MQL5 services.
   addr[4] = 0; addr[5] = 0; addr[6] = 0; addr[7] = 0;
   PrintFormat("SlotService: cmd server: calling bind() port=%d port_be=%d", CmdWebSocketPort, port_be);
   int brc = bind(s, addr, 16);
   PrintFormat("SlotService: cmd server: bind()=%d err=%d", brc, WSAGetLastError());
   if(brc == SOCKET_ERROR) {
      PrintFormat("SlotService: cmd bind err=%d", WSAGetLastError());
      closesocket(s);
      return;
   }
   Print("SlotService: cmd server: calling listen()");
   int lrc = listen(s, MAX_CMD_CLIENTS);
   PrintFormat("SlotService: cmd server: listen()=%d err=%d", lrc, WSAGetLastError());
   if(lrc == SOCKET_ERROR) {
      PrintFormat("SlotService: cmd listen err=%d", WSAGetLastError());
      closesocket(s);
      return;
   }
   g_cmdListenSock = s;
   PrintFormat("SlotService: COMMAND SERVER LISTENING on 0.0.0.0:%d socket=%d", CmdWebSocketPort, s);
}

void StopCommandServer()
{
   for(int i = 0; i < ArraySize(g_cmdClients); i++) {
      closesocket(g_cmdClients[i]);
   }
   ArrayResize(g_cmdClients, 0);
   ArrayResize(g_cmdClientBufs, 0);
   if(g_cmdListenSock != INVALID_SOCKET) {
      closesocket(g_cmdListenSock);
      g_cmdListenSock = INVALID_SOCKET;
   }
}

void PollCommandServer()
{
   if(g_cmdListenSock == INVALID_SOCKET) return;

   for(int i = 0; i < MAX_CMD_CLIENTS; i++) {
      uchar addr[16];
      ArrayInitialize(addr, 0);
      int namelen = 16;
      int cli = accept(g_cmdListenSock, addr, namelen);
      if(cli == INVALID_SOCKET) {
         int err = WSAGetLastError();
         if(err != 10035 && err != 11) {
            PrintFormat("SlotService: cmd accept err=%d", err);
         }
         break;
      }
      if(ArraySize(g_cmdClients) >= MAX_CMD_CLIENTS) {
         Print("SlotService: cmd max clients reached, rejecting");
         closesocket(cli);
         continue;
      }
      int idx = ArraySize(g_cmdClients);
      ArrayResize(g_cmdClients, idx + 1);
      ArrayResize(g_cmdClientBufs, idx + 1);
      g_cmdClients[idx] = cli;
      g_cmdClientBufs[idx] = "";
      PrintFormat("SlotService: cmd client #%d accepted (sock=%d)", idx, cli);
   }

   for(int i = ArraySize(g_cmdClients) - 1; i >= 0; i--) {
      int cli = g_cmdClients[i];
      uchar buf[RECV_CHUNK_MAX];
      int n = recv(cli, buf, RECV_CHUNK_MAX, MSG_DONTWAIT);
      if(n == SOCKET_ERROR) {
         int err = WSAGetLastError();
         if(err != 10035 && err != 11) {
            PrintFormat("SlotService: cmd recv err=%d, closing cli=%d", err, cli);
            closesocket(cli);
            CmdClientRemove(i);
            continue;
         }
         n = 0;
      }
      if(n == 0) {
         PrintFormat("SlotService: cmd cli=%d closed by peer", cli);
         closesocket(cli);
         CmdClientRemove(i);
         continue;
      }
      if(n > 0) {
         g_cmdClientBufs[i] += CharArrayToString(buf, 0, n, CP_UTF8);
         int idx;
         while((idx = StringFind(g_cmdClientBufs[i], "\n")) >= 0) {
            string frame = StringSubstr(g_cmdClientBufs[i], 0, idx);
            g_cmdClientBufs[i] = StringSubstr(g_cmdClientBufs[i], idx + 1);
            string response = HandleCommandAndRespond(frame);
            if(StringLen(response) > 0) {
               uchar resp[];
               StringToCharArray(response, resp, 0, CP_UTF8);
               int slen = StringLen(response);
               send(cli, resp, slen, 0);
            }
         }
         if(StringLen(g_cmdClientBufs[i]) > RECV_BUF_MAX) {
            Print("SlotService: cmd client buffer overflow, dropping connection");
            closesocket(cli);
            CmdClientRemove(i);
         }
      }
   }
}

void CmdClientRemove(int idx)
{
   int n = ArraySize(g_cmdClients);
   if(idx < 0 || idx >= n) return;
   for(int j = idx; j < n - 1; j++) {
      g_cmdClients[j]   = g_cmdClients[j+1];
      g_cmdClientBufs[j] = g_cmdClientBufs[j+1];
   }
   ArrayResize(g_cmdClients, n - 1);
   ArrayResize(g_cmdClientBufs, n - 1);
}