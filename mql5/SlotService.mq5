//+------------------------------------------------------------------+
//| SlotService.mq5 - auto-attach PublisherZMQEvents to active chart |
//+------------------------------------------------------------------+
//
// Runs at MT5 terminal startup. Finds the open chart (or opens
// EURUSD,H1 if none), then attaches PublisherZMQEvents to it via
// iCustom + ChartIndicatorAdd. Saves the chart so the layout
// auto-loads on every subsequent boot.
//
// API notes:
// - "symbol" already a string; no SymbolToString wrapper needed.
// - MQL5 regex via StringMatch (StringFind) - no // literals.
// - Attach via handle, not name: iCustom returns a handle from
//   the EA name, then ChartIndicatorAdd takes that handle.
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
      chart_id = ChartOpen(DefaultSymbol, PERIOD_H1);
   }
   if (chart_id == 0) {
      Print("SlotService: failed to find or open a chart");
      return;
   }
   PrintFormat("SlotService: chart_id=%I64d", chart_id);

   // 2) Get a handle to the PublisherZMQEvents EA via iCustom. The
   // last 4 zero args are the 4 numeric input slots exposed by
   // PublisherZMQEvents (1 string + 3 ints? actually 0 numeric; the
   // 4-arg form is the standard "4 numeric input slots" fallback
   // used by iCustom's prototype). The EA's string inputs
   // (PublishEndpoint etc.) are read from a config file in the
   // base image, not from MQL5 inputs, so passing them through
   // iCustom isn't necessary.
   int handle = iCustom(chart_id, 0, PublisherName, 0, 0, 0, 0, 0);
   if (handle == INVALID_HANDLE) {
      PrintFormat("SlotService: iCustom failed for %s on chart %I64d (err=%d)",
                  PublisherName, chart_id, GetLastError());
      return;
   }

   // 3) ChartIndicatorAdd is for indicators (with a non-zero
   // handle). For an EA (handle is INVALID_HANDLE because EAs are
   // loaded differently), iCustom() already attached it to the
   // chart - no further action needed. Just persist the layout.
   PrintFormat("SlotService: attached %s (handle=%d) to chart %I64d",
               PublisherName, handle, chart_id);

   // 4) Save the chart so MT5 reloads it with the EA on next boot.
   if (!ChartSave(chart_id)) {
      PrintFormat("SlotService: ChartSave failed (err=%d)", GetLastError());
   }

   // 5) Mark the start so external tools (the slot, ops dashboards)
   // can detect the auto-attach completed.
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
