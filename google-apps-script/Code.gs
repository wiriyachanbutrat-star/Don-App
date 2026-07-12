/**
 * Gold AI Analyzer — win/loss history sync endpoint.
 *
 * Setup:
 * 1. Go to https://sheets.google.com and create a new blank spreadsheet
 *    (e.g. name it "Gold AI Win-Loss Track Record").
 * 2. In the sheet, open Extensions > Apps Script.
 * 3. Delete any starter code and paste this whole file in.
 * 4. Click Deploy > New deployment > type: Web app.
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the Web app URL and paste it into the "Google Sheet Webhook URL"
 *    box on the gold.html page. Every time a trade result is recorded there,
 *    it will overwrite a sheet tab named after the asset (XAU / BTC) with
 *    the full up-to-date history plus a win/loss/win-rate summary.
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var asset = data.asset || 'XAU';
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(asset);
    if (!sheet) {
      sheet = ss.insertSheet(asset);
    }
    sheet.clearContents();

    var header = [
      'Time', 'Direction', 'Entry', 'TP', 'SL', 'Status', 'Closed Price', 'Closed Time',
      'RSI', 'EMA Aligned', 'Counter Higher Trend', 'Signal Score', 'Signal Strong',
    ];
    sheet.appendRow(header);

    rows.forEach(function (r) {
      var snap = r.snapshot || {};
      sheet.appendRow([
        r.time ? new Date(r.time) : '',
        r.direction || '',
        r.entry != null ? r.entry : '',
        r.tp != null ? r.tp : '',
        r.sl != null ? r.sl : '',
        r.status || '',
        r.closedPrice != null ? r.closedPrice : '',
        r.closedTime ? new Date(r.closedTime) : '',
        snap.rsi != null ? snap.rsi : '',
        snap.emaAligned != null ? snap.emaAligned : '',
        snap.counterHigherTrend != null ? snap.counterHigherTrend : '',
        snap.signalScore != null ? snap.signalScore : '',
        snap.signalStrong != null ? snap.signalStrong : '',
      ]);
    });

    var wins = rows.filter(function (r) { return r.status === 'win'; }).length;
    var losses = rows.filter(function (r) { return r.status === 'loss'; }).length;
    var pending = rows.filter(function (r) { return r.status === 'pending'; }).length;
    var closed = wins + losses;
    var winRate = closed > 0 ? Math.round((wins / closed) * 100) + '%' : '-';

    // Columns A-M are now used by the row data (including the snapshot fields
    // added above), so the summary block lives further out at O/P to avoid
    // overlapping them.
    sheet.getRange(1, 15).setValue('Win');       sheet.getRange(1, 16).setValue(wins);
    sheet.getRange(2, 15).setValue('Loss');      sheet.getRange(2, 16).setValue(losses);
    sheet.getRange(3, 15).setValue('Pending');   sheet.getRange(3, 16).setValue(pending);
    sheet.getRange(4, 15).setValue('Win Rate');  sheet.getRange(4, 16).setValue(winRate);
    sheet.getRange(5, 15).setValue('Updated');   sheet.getRange(5, 16).setValue(new Date());

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, wins: wins, losses: losses, pending: pending, winRate: winRate }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, message: 'Gold AI history sync endpoint is live' }))
    .setMimeType(ContentService.MimeType.JSON);
}
