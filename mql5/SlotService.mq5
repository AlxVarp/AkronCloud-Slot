//+------------------------------------------------------------------+
//| SlotService.mq5 - service that bridges the slot with MT5 via TCP |
//|             (Phase C / Ruta B1 — replaces file-bridge stack)    |
//+------------------------------------------------------------------+
//
// Runs as a #property service, launched by MT5 at terminal startup
// (registered in MQL5/profiles/default/services.ini). No chart
// dependency, no template, no manual attach.
//
// Communicates with the slot over a single TCP socket on
// 127.0.0.1:7778 (the slot binds; MQL5 connects). Wire protocol is
// newline-delimited JSON. Maximum frame size 64 KB.
//
//   MQL5 -> host (frames):
//     {"type":"event","kind":"fill"|"order_state"|"position"|"account",
//      "data":{...},"ts":<epoch_ms>}
//     {"type":"response","id":"<uuid>","ok":true|false,
//      "result":{...}|"error":"..."}
//
//   host -> MQL5 (frames):
//     {"type":"command","id":"<uuid>","action":"open"|"close"|"cancel"|"sltp",
//      "payload":{...}}
//
// Requires `AllowDllImport=1` in MQL5/Config/terminal.ini (the
// Dockerfile sets this in Phase 1 build step). Pulls ws2_32.dll
// from Wine — present in /opt/wine-stable/lib/wine.
//
//+------------------------------------------------------------------+
#property copyright "akroncloud-slot"
#property version   "2.10"
#property service
#property strict  false

//+------------------------------------------------------------------+
//| ws2_32 (Windows Sockets) imports — Phase C / Ruta B1             |
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
input int     StartupMarkerWaitMs = 3000;

datetime g_lastPollTime       = 0;
string   g_lastProcessedCmdId  = "";
datetime g_lastCmdMtime       = 0;

int    g_cmdSock     = INVALID_SOCKET;
string g_recvBuf     = "";
int    g_lastWSAErr  = 0;
bool   g_lastConnected = false;

int OnStart()
{
   PrintFormat("SlotService: start on %s poll=%ds", _Symbol, PollSeconds);
   uchar wsadata[408];
   int rc = WSAStartup(0x0202, wsadata);
   if(rc != 0) { Print("SlotService: WSAStartup failed"); return INIT_FAILED; }
   ConnectToSlot();
   SendStartupEvent();
   g_lastPollTime = TimeCurrent();
   EventSetMillisecondTimer(MathMax(50, PollSeconds * 1000));
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(g_cmdSock != INVALID_SOCKET) {
      closesocket(g_cmdSock);
      g_cmdSock = INVALID_SOCKET;
   }
   WSACleanup();
}

void OnTimer()
{
   if(g_cmdSock == INVALID_SOCKET) {
      ConnectToSlot();
      if(g_cmdSock == INVALID_SOCKET) return;
   }

   // 1) Drain recv — non-blocking, accumulate frames by '\n'
   uchar buf[RECV_CHUNK_MAX];
   int n = recv(g_cmdSock, buf, RECV_CHUNK_MAX, MSG_DONTWAIT);
   if(n == SOCKET_ERROR) {
      g_lastWSAErr = WSAGetLastError();
      PrintFormat("SlotService: recv error %d, closing", g_lastWSAErr);
      closesocket(g_cmdSock);
      g_cmdSock = INVALID_SOCKET;
      return;
   }
   if(n == 0) {
      Print("SlotService: peer closed");
      closesocket(g_cmdSock);
      g_cmdSock = INVALID_SOCKET;
      return;
   }
   if(n > 0) {
      g_recvBuf += CharArrayToString(buf, 0, n, CP_UTF8);
      int idx;
      while((idx = StringFind(g_recvBuf, "\n")) >= 0) {
         string frame = StringSubstr(g_recvBuf, 0, idx);
         g_recvBuf = StringSubstr(g_recvBuf, idx + 1);
         ProcessCommandFrame(frame);
      }
      if(StringLen(g_recvBuf) > RECV_BUF_MAX) {
         Print("SlotService: recv buffer overflow, dropping");
         g_recvBuf = "";
      }
   }

   // 2) Periodically push state snapshot
   if(TimeCurrent() - g_lastPollTime >= PollSeconds) {
      g_lastPollTime = TimeCurrent();
      SendFrame("{\"type\":\"event\",\"kind\":\"state\",\"ts\":"
                + TimeToMs(TimeCurrent()) + ",\"data\":"
                + BuildStateJson() + "}");

      // Detect broker connection state change. Emits account_status
      // so the slot's connector can flip `loggedIn` for the right
      // account. Fires on every transition (login/logout/connect-loss)
      // and on the first tick after MT5 boot (initial state).
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

void ProcessCommandFrame(string frame)
{
   string id      = JsonField(frame, "id");
   string action = JsonField(frame, "action");
   bool   ok     = false;
   string result = "{\"error\":\"unknown_action\"}";
   if(action == "open")   { ok = true; result = HandleOpen(frame); }
   else if(action == "close")  { ok = true; result = HandleClose(frame); }
   else if(action == "cancel") { ok = true; result = HandleCancel(frame); }
   else if(action == "sltp")   { ok = true; result = HandleSltp(frame); }
   SendFrame("{\"type\":\"response\",\"id\":\"" + id
             + "\",\"ok\":" + (ok ? "true" : "false")
             + ",\"result\":" + result + "}");
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
