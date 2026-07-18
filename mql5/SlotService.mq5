//+------------------------------------------------------------------+
//| SlotService.mq5 - auto-attach the broker publisher EA at startup |
//+------------------------------------------------------------------+
//
// Runs as a MQL5 "service" at MT5 terminal startup. It finds (or
// opens) a chart, attaches the broker publisher EA, and writes a
// startup marker so the slot can detect the auto-attach completed.
//
// The publisher EA subscribes to the chart's symbol, so the user can
// change the chart's symbol at any time after boot and the
// publication follows automatically - no hard-coded symbol here.
//
// Build (inside the running container):
//   wine "Z:\\Program Files\\MetaTrader 5\\metaeditor64.exe" /compile:Z:\\app\\mql5\\SlotService.mq5 /include:Z:\\app\\mql5
// then install the .ex5 and register the service in
// MQL5/Profiles/Default/services.ini.

#property service
#property copyright "akroncloud-slot"
#property version   "1.00"

input string DefaultSymbol = "EURUSD";
input string PublisherName = "PublisherZMQEvents";

void OnStart()
{
   PrintFormat("SlotService: start, default=%s publisher=%s",
               DefaultSymbol, PublisherName);

   // 1) Find an existing chart, or open a fresh one.
   long chart_id = ChartFirst();
   if (chart_id == 0) {
      // ChartOpen signature: (symbol, period). Use H1 as default
      // timeframe; user can change it on the chart at any time.
      chart_id = ChartOpen(SymbolToString(DefaultSymbol), PERIOD_H1);
   }
   if (chart_id == 0) {
      Print("SlotService: failed to find/open chart");
      return;
   }
   PrintFormat("SlotService: chart_id=%I64d", chart_id);

   // 2) Check whether the publisher is already attached.
   int already = 0;
   int total  = ChartIndicatorsTotal(chart_id);
   for (int i = 0; i < total; i++) {
      string name = ChartIndicatorName(chart_id, i);
      if (name == PublisherName) { already = 1; break; }
   }
   if (already) {
      PrintFormat("SlotService: %s already attached to chart %I64d", PublisherName, chart_id);
      WriteStartupMarker();
      return;
   }

   // 3) Attach the publisher EA. ChartIndicatorAdd's signature is
   // (chart_id, sub_window, name, params...). Empty params string
   // means "use the EA's default inputs". We pass 0 for "main window".
   if (!ChartIndicatorAdd(chart_id, 0, PublisherName, 0, 0, 0, 0, "")) {
      PrintFormat("SlotService: failed to attach %s (err=%d)",
                  PublisherName, GetLastError());
      return;
   }
   PrintFormat("SlotService: attached %s to chart %I64d", PublisherName, chart_id);

   WriteStartupMarker();
}

void WriteStartupMarker()
{
   string p = TerminalInfoString(TERMINAL_DATA_PATH)
            + "\\MQL5\\Files\\slot-autostart.done";
   FileDelete(p);
   int h = FileOpen(p, FILE_WRITE|FILE_TXT|FILE_ANSI);
   if (h == INVALID_HANDLE) return;
   FileWriteString(h, "ok " + TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
   FileClose(h);
}
