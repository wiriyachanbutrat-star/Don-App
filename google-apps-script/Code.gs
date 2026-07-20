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
 * 6. The sheet is the source of truth across devices: gold.html calls
 *    GET <web app url>?asset=XAU on load to pull history down before
 *    rendering, so opening the page on a different phone/PC shows the same
 *    win/loss record instead of each device's own local-only copy.
 * 7. The "บันทึกการเทรด" (trade journal) section on gold.html — date, ทุน
 *    (capital), กำไร (profit) — is synced the same way but lives in its own
 *    "TradeJournal" tab, via POST/GET with type=journal.
 *
 * IMPORTANT: after editing this file, re-deploy (Deploy > Manage deployments
 * > edit > New version) — editing the script alone does NOT update the live
 * /exec URL that gold.html is already calling.
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (data.type === 'journal') {
      return handleJournalPost(data);
    }

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
      'RSI', 'EMA Aligned', 'Counter Higher Trend', 'Signal Score', 'Signal Strong', 'RawJSON',
    ];
    sheet.appendRow(header);

    rows.forEach(function (r) {
      var snap = r.snapshot || {};
      // RawJSON (column N) is the source of truth doGet() reads back from —
      // the other columns are just for a human glancing at the sheet. Storing
      // the exact row object round-trips every field (including ones not
      // broken out into their own column) instead of reconstructing an
      // approximation from the readable columns.
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
        JSON.stringify(r),
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

// Manual trade journal (date / capital / profit), kept in its own sheet tab
// separate from the per-asset win/loss tabs above so the two logs don't mix.
function handleJournalPost(data) {
  var rows = Array.isArray(data.rows) ? data.rows : [];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('TradeJournal');
  if (!sheet) {
    sheet = ss.insertSheet('TradeJournal');
  }
  sheet.clearContents();

  sheet.appendRow(['Date', 'Capital', 'Profit', 'RawJSON']);
  rows.forEach(function (r) {
    sheet.appendRow([
      r.date || '',
      r.capital != null ? r.capital : '',
      r.profit != null ? r.profit : '',
      JSON.stringify(r),
    ]);
  });

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, count: rows.length }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleJournalGet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('TradeJournal');
  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, rows: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  var rows = [];
  // Row 0 is the header; RawJSON lives in column D (index 3).
  for (var i = 1; i < data.length; i++) {
    var raw = data[i][3];
    if (!raw) continue;
    try { rows.push(JSON.parse(raw)); } catch (parseErr) { /* skip malformed row */ }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, rows: rows }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Reads history back so any device loading the page can pull the same
// trade history that was last synced from any other device — GET
// /exec?asset=XAU returns { ok: true, rows: [...] } in the same shape
// gold.html stores in localStorage.
function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.type === 'journal') {
      return handleJournalGet();
    }

    var asset = (e && e.parameter && e.parameter.asset) || 'XAU';
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(asset);
    if (!sheet) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, rows: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var data = sheet.getDataRange().getValues();
    var rows = [];
    // Row 0 is the header; RawJSON lives in column N (index 13).
    for (var i = 1; i < data.length; i++) {
      var raw = data[i][13];
      if (!raw) continue;
      try { rows.push(JSON.parse(raw)); } catch (parseErr) { /* skip malformed row */ }
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, rows: rows }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err), rows: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
