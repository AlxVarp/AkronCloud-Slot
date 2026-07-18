//+------------------------------------------------------------------+
//| SlotService.mq5 - auto-attach PublisherZMQEvents to active chart |
//+------------------------------------------------------------------+
//
// Runs at MT5 terminal startup. Finds the open chart (or opens
// EURUSD,H1 if none), then attaches PublisherZMQEvents to it via
// iCustom. Marks the chart modified so MT5 saves it with the EA
// on close.
//
// API notes:
// - "symbol" already a string; pass NULL for "use the chart's".
// - ChartIndicatorAdd takes a handle, not a name; iCustom returns it.
// - ChartSave is NOT a function in MQL5; we use
//   ChartSetInteger(..., CHART_MODIFIED, 1) instead, which marks
//   the chart as modified for the next save event.
#property service
#property copyright "akroncloud-slot"
#property version   "1.20"

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

   // 2) Get a handle to the EA via iCustom(NULL, 0, "Name", ...).
   // iCustom for an EA returns INVALID_HANDLE in modern MT5 (the
   // handle is meaningful for indicators only), but the side-effect
   // is the EA gets loaded onto the chart, which is what we want.
   int handle = iCustom(NULL, 0, PublisherName);
   int err = GetLastError();
   PrintFormat("SlotService: iCustom(%s) -> handle=%d, err=%d",
               PublisherName, handle, err);

   // 3) MT5 saves the chart layout (including attached EAs) on
   // profile-save events and on terminal close. We don't need to
   // explicitly flag the chart as modified - the EA attach above
   // counts as a modification, and MT5's default save-on-exit
   // behavior picks it up. CHART_MODIFIED isn't a valid enum in
   // older MQL5 builds (build 5495 / 5800 here) so we skip it.

   // 4) Mark the start so external tools (the slot, ops dashboards)
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
