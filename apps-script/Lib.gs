/**
 * Lib.gs — shared primitives used by every other script in this project.
 *
 * Everything here exists because of a specific failure mode seen in inherited
 * spreadsheet systems:
 *
 *   withLock()  — a manual run and a scheduled trigger firing at the same time,
 *                 both mid-write to the same range, producing interleaved rows.
 *   retry()     — transient "Service Spreadsheets timed out" / "Internal error"
 *                 failures that kill an entire weekly close for no real reason.
 *   log()       — script failures that nobody noticed for three weeks because
 *                 Apps Script executions are not something anyone checks.
 *   Sheets.get  — silent creation of a tab that was supposed to already exist,
 *                 which turns a config typo into an empty report.
 */

const Lib = (function () {

  const LOG_SHEET = '_Log';
  const LOG_MAX_ROWS = 5000;

  /**
   * Runs fn while holding the document lock. Prevents a manual menu run and a
   * time-driven trigger from writing the same ranges concurrently.
   *
   * @param {string} label        Name used in logs.
   * @param {!Function} fn        Work to perform.
   * @param {number=} waitMs      How long to wait for the lock. Default 30s.
   * @return {*} fn's return value.
   */
  function withLock(label, fn, waitMs) {
    const lock = LockService.getDocumentLock();
    if (!lock.tryLock(waitMs || 30 * 1000)) {
      log('WARN', label, 'Could not acquire lock; another run is in progress. Skipping.');
      return null;
    }
    const started = Date.now();
    try {
      const result = fn();
      log('INFO', label, 'Completed in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
      return result;
    } catch (err) {
      log('ERROR', label, err && err.stack ? err.stack : String(err));
      throw err;
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Retries fn with exponential backoff. Only for transient Google service
   * errors — do not wrap logic errors in this, it just makes them slower.
   *
   * @param {!Function} fn
   * @param {number=} attempts Default 4.
   * @return {*}
   */
  function retry(fn, attempts) {
    const max = attempts || 4;
    let lastErr;
    for (let i = 0; i < max; i++) {
      try {
        return fn();
      } catch (err) {
        lastErr = err;
        if (i === max - 1) break;
        Utilities.sleep(Math.pow(2, i) * 1000 + Math.floor(Math.random() * 500));
      }
    }
    throw lastErr;
  }

  /**
   * Appends a structured row to the _Log sheet and trims it so the log never
   * becomes the largest tab in the workbook.
   *
   * @param {string} level  INFO | WARN | ERROR
   * @param {string} source
   * @param {string} message
   */
  function log(level, source, message) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let sheet = ss.getSheetByName(LOG_SHEET);
      if (!sheet) {
        sheet = ss.insertSheet(LOG_SHEET);
        sheet.appendRow(['Timestamp', 'Level', 'Source', 'Message']);
        sheet.setFrozenRows(1);
        sheet.hideSheet();
      }
      sheet.appendRow([new Date(), level, source, String(message).slice(0, 4000)]);

      const rows = sheet.getLastRow();
      if (rows > LOG_MAX_ROWS) {
        sheet.deleteRows(2, rows - LOG_MAX_ROWS);
      }
    } catch (e) {
      // Logging must never be the reason a job fails.
      console.error('Lib.log failed: ' + e);
    }
  }

  /**
   * Fetches a sheet by name and throws a useful error if it is missing.
   * The default SpreadsheetApp behaviour — returning null — turns a config
   * typo into "Cannot read property getDataRange of null" 40 lines later.
   *
   * @param {string} name
   * @param {Spreadsheet=} ss
   * @return {Sheet}
   */
  function mustGetSheet(name, ss) {
    const book = ss || SpreadsheetApp.getActiveSpreadsheet();
    const sheet = book.getSheetByName(name);
    if (!sheet) {
      throw new Error(
        'Required sheet "' + name + '" not found in "' + book.getName() + '". ' +
        'If it was renamed, update the Config tab rather than the script.');
    }
    return sheet;
  }

  /**
   * Reads a sheet as an array of objects keyed by its header row.
   * One batched getValues() call — never read row by row.
   *
   * @param {Sheet} sheet
   * @param {number=} headerRow 1-indexed. Default 1.
   * @return {!Array<!Object>}
   */
  function readObjects(sheet, headerRow) {
    const hRow = headerRow || 1;
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow <= hRow || lastCol === 0) return [];

    const values = sheet.getRange(hRow, 1, lastRow - hRow + 1, lastCol).getValues();
    const headers = values.shift().map(function (h) { return String(h).trim(); });

    return values
      .filter(function (row) {
        return row.some(function (c) { return c !== '' && c !== null; });
      })
      .map(function (row) {
        const obj = {};
        headers.forEach(function (h, i) { if (h) obj[h] = row[i]; });
        return obj;
      });
  }

  /**
   * Writes a 2D array to a sheet in one batched call, clearing any stale rows
   * below it. Writing row-by-row is the single most common cause of the
   * six-minute execution limit in inherited scripts.
   *
   * @param {Sheet} sheet
   * @param {!Array<!Array>} rows Including the header row.
   * @param {number=} startRow Default 1.
   */
  function writeTable(sheet, rows, startRow) {
    const start = startRow || 1;
    if (!rows.length) {
      sheet.getRange(start, 1, Math.max(sheet.getMaxRows() - start + 1, 1), sheet.getMaxColumns()).clearContent();
      return;
    }
    const width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    const padded = rows.map(function (r) {
      const copy = r.slice();
      while (copy.length < width) copy.push('');
      return copy;
    });

    const existingRows = sheet.getMaxRows() - start + 1;
    if (existingRows > 0) {
      sheet.getRange(start, 1, existingRows, sheet.getMaxColumns()).clearContent();
    }
    if (sheet.getMaxRows() < start + padded.length - 1) {
      sheet.insertRowsAfter(sheet.getMaxRows(), start + padded.length - 1 - sheet.getMaxRows());
    }
    sheet.getRange(start, 1, padded.length, width).setValues(padded);
  }

  /**
   * Sends a failure notification. Keeps alerting in one place so the recipient
   * list is a config change, not a code change.
   *
   * @param {string} subject
   * @param {string} body
   * @param {!Array<string>} recipients
   */
  function alert(subject, body, recipients) {
    if (!recipients || !recipients.length) {
      log('WARN', 'Lib.alert', 'No alert recipients configured; suppressing: ' + subject);
      return;
    }
    const quota = MailApp.getRemainingDailyQuota();
    if (quota < 1) {
      log('ERROR', 'Lib.alert', 'Mail quota exhausted; could not send: ' + subject);
      return;
    }
    MailApp.sendEmail({
      to: recipients.join(','),
      subject: subject,
      body: body + '\n\n— Sales Ops automation\n' +
            SpreadsheetApp.getActiveSpreadsheet().getUrl()
    });
  }

  /** Normalises a key for joining: trims, collapses whitespace, lowercases. */
  function normKey(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /** ISO week label, e.g. "2026-W07". Used as the snapshot period key. */
  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return d.getUTCFullYear() + '-W' + ('0' + week).slice(-2);
  }

  return {
    withLock: withLock,
    retry: retry,
    log: log,
    mustGetSheet: mustGetSheet,
    readObjects: readObjects,
    writeTable: writeTable,
    alert: alert,
    normKey: normKey,
    isoWeek: isoWeek
  };
})();
