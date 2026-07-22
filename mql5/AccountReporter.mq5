//+------------------------------------------------------------------+
//|                                       AccountReporter.mq5         |
//|                        AkronCloud-Slot v55 — Phase A             |
//+------------------------------------------------------------------+
//| Purpose                                                           |
//|--------------------------------------------------------------------
//| Chart indicator that polls the connected MT5 account every
//| PollSeconds seconds and writes the current balance/equity/login/
//| server to MQL5/Files/slot-state.json. The slot's mt5-state-bridge
//| (src/services/mt5-state-bridge.py) watches that file and forwards
//| it to the slot's Mt5TcpServer (TCP 127.0.0.1:7778).
//|
//| Why an indicator and not a service (#property service)?
//|--------------------------------------------------------------------
//| SlotService.ex5 is a #property service. Services don't autostart
//| on a fresh WINEPREFIX — MT5's "Services" tab is empty until the
//| user right-clicks → Add Service on the .ex5 in MQL5/Services/.
//| That step is the "manual VNC add" the user has to do on every
//| fresh slot.
//|
//| Indicators autostart the moment any chart is loaded — which MT5
//| does by default when it boots (the default chart template).
//| So an indicator gives us "user just logs into MT5 → balance
//| appears in /v1/state" with zero manual setup, as long as the
//| indicator is attached to the default chart.
//|
//| First-run attach (one-time, per fresh WINEPREFIX):
//|   1. Open the KasmVNC viewer (http://<host>:7777/mobile).
//|   2. MT5 will already have a default chart open.
//|   3. Drag "AccountReporter" from the Navigator → Indicators
//|      panel onto the chart.
//|   4. Save the chart template: Charts → Templates → Save Template
//|      → name it "default". The next time MT5 boots, it loads
//|      default.tpl and the indicator comes back automatically.
//|
//| Build:
//|   metaeditor64.exe /compile:"MQL5\Indicators\AccountReporter.mq5"
//|   (the compiled .ex5 is committed alongside this .mq5 by the
//|   developer who has a working metaeditor environment).
//+------------------------------------------------------------------+
#property copyright "AkronCloud-Slot"
#property version   "1.00"
#property description "Reports MT5 account balance/equity to the slot"
#property indicator_chart_window
#property indicator_plots 0

input int PollSeconds = 5;   // How often to write the state file (1-60)

//+------------------------------------------------------------------+
//| Init — schedule timer + write first state immediately             |
//+------------------------------------------------------------------+
int OnInit()
{
   int clamped = MathMax(1, MathMin(60, PollSeconds));
   EventSetTimer(clamped);
   WriteAccountState();
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Deinit — clear timer                                              |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
}

//+------------------------------------------------------------------+
//| Timer — called every PollSeconds                                  |
//+------------------------------------------------------------------+
void OnTimer()
{
   WriteAccountState();
}

//+------------------------------------------------------------------+
//| Write the current account state to slot-state.json (atomic)       |
//+------------------------------------------------------------------+
void WriteAccountState()
{
   long   login    = AccountInfoInteger(ACCOUNT_LOGIN);
   string server   = AccountInfoString(ACCOUNT_SERVER);
   double balance  = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity   = AccountInfoDouble(ACCOUNT_EQUITY);

   bool logged_in = (login != 0);

   // MQL5 has no native JSON serializer — build the string manually.
   // Numbers use '.' decimal (MT5 brokers are universally '.' locale);
   // strings are JSON-escaped.
   string json = "";
   json += "{\"logged_in\":";
   json += (logged_in ? "true" : "false");
   json += ",\"login\":";
   json += IntegerToString(login);
   json += ",\"server\":\"";
   json += EscapeJson(server);
   json += "\",\"balance\":";
   json += DoubleToString(balance, 2);
   json += ",\"equity\":";
   json += DoubleToString(equity, 2);
   json += ",\"ts\":";
   json += IntegerToString(TimeLocal());
   json += "}";

   // Atomic write: write to slot-state.json.tmp then rename.
   // FileMove with FILE_REWRITE does the atomic replace. The bridge
   // watcher polls the file and ignores partial writes.
   const string fname   = "slot-state.json";
   const string tmpname = "slot-state.json.tmp";

   int h = FileOpen(tmpname,
                    FILE_WRITE | FILE_TXT | FILE_ANSI |
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    '\n');
   if(h == INVALID_HANDLE)
   {
      Print("AccountReporter: cannot open ", tmpname, " err=", GetLastError());
      return;
   }
   FileWriteString(h, json);
   FileClose(h);

   if(!FileMove(tmpname, 0, fname, FILE_REWRITE))
   {
      Print("AccountReporter: rename failed err=", GetLastError());
   }
}

//+------------------------------------------------------------------+
//| Minimal JSON string escape                                        |
//+------------------------------------------------------------------+
string EscapeJson(string s)
{
   string out = "";
   int len = StringLen(s);
   for(int i = 0; i < len; i++)
   {
      ushort c = StringGetCharacter(s, i);
      if(c == '"' || c == '\\')
      {
         out += "\\";
         out += ShortToString(c);
      }
      else if(c == '\n') out += "\\n";
      else if(c == '\r') out += "\\r";
      else if(c == '\t') out += "\\t";
      else                out += ShortToString(c);
   }
   return out;
}
//+------------------------------------------------------------------+