/**
 * Audit.gs — read-only scanner for an inherited Google Sheets system.
 *
 * This is the first thing I run on an engagement, before any change is
 * proposed and long before any change is made. It writes two tabs and touches
 * nothing else:
 *
 *   _Audit Summary   one row per tab: size, formula census, cost signals
 *   _Audit Findings  one row per issue, with severity and location
 *
 * Design notes
 * ------------
 * - Read-only by contract. It never edits a formula, a value or a format.
 * - Batched reads only. One getFormulas() per sheet, not per cell.
 * - Pattern detection is deliberately conservative: I would rather surface a
 *   false positive that takes 10 seconds to dismiss than miss the VLOOKUP that
 *   silently returns the wrong column after someone inserts one.
 *
 * Usage: Sales Ops menu → "Run system audit", or run auditWorkbook() directly.
 */

const Audit = (function () {

  const SUMMARY_SHEET = '_Audit Summary';
  const FINDINGS_SHEET = '_Audit Findings';

  /** Hard cap so the scan cannot itself time out on a very large workbook. */
  const MAX_CELLS_PER_SHEET = 400000;

  /** A formula repeated at least this many times is a single-array candidate. */
  const FILL_DOWN_THRESHOLD = 50;

  const PATTERNS = {
    volatile:        /\b(NOW|TODAY|RAND|RANDBETWEEN|INDIRECT|OFFSET)\s*\(/i,
    positionalLookup:/\b[VH]LOOKUP\s*\(/i,
    importRange:     /\bIMPORTRANGE\s*\(/i,
    query:           /\bQUERY\s*\(/i,
    arrayFormula:    /\bARRAYFORMULA\s*\(/i,
    blanketIfError:  /\bIFERROR\s*\(/i,
    emptyFallback:   /,\s*""\s*\)\s*$/,
    // Matches A:A and 'Sheet Name'!$A:$Z, but deliberately NOT the recommended
    // open-ended form $A$2:$A — the row anchor is what makes that one safe.
    fullColumnRef:   /(^|[^A-Za-z0-9_$])\$?[A-Z]{1,3}:\$?[A-Z]{1,3}(?![0-9A-Za-z_])/,
    hardcodedDate:   /(\bDATE\s*\(\s*20\d\d\s*,)|("20\d\d-\d{1,2}-\d{1,2}")|(\b\d{1,2}\/\d{1,2}\/20\d\d\b)/,
    externalSheetRef:/(?:'([^']+)'|([A-Za-z0-9_]+))!\$?[A-Z]{1,3}\$?\d*/g,
    importRangeKey:  /IMPORTRANGE\s*\(\s*"([^"]+)"/ig
  };

  /* ------------------------------------------------------------------ *
   * Entry point
   * ------------------------------------------------------------------ */

  /**
   * Audits the active workbook and writes the two report tabs.
   * @return {!Object} The raw result, for testing or further processing.
   */
  function auditWorkbook() {
    const started = Date.now();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = ss.getSheets();

    const summaries = [];
    const findings = [];
    const importTargets = {};

    sheets.forEach(function (sheet) {
      const name = sheet.getName();
      if (name === SUMMARY_SHEET || name === FINDINGS_SHEET || name === '_Log') return;

      const result = auditSheet(sheet);
      summaries.push(result.summary);
      Array.prototype.push.apply(findings, result.findings);
      Object.keys(result.importTargets).forEach(function (k) {
        importTargets[k] = (importTargets[k] || 0) + result.importTargets[k];
      });
    });

    Array.prototype.push.apply(findings, auditWorkbookLevel(ss, summaries, importTargets));

    writeSummary(ss, summaries, started);
    writeFindings(ss, findings);

    Lib.log('INFO', 'Audit', 'Scanned ' + summaries.length + ' tabs, ' +
      findings.length + ' findings, ' +
      ((Date.now() - started) / 1000).toFixed(1) + 's');

    return { summaries: summaries, findings: findings };
  }

  /* ------------------------------------------------------------------ *
   * Per-sheet scan
   * ------------------------------------------------------------------ */

  function auditSheet(sheet) {
    const name = sheet.getName();
    const findings = [];
    const importTargets = {};

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const maxRow = sheet.getMaxRows();
    const maxCol = sheet.getMaxColumns();

    const summary = {
      sheet: name,
      hidden: sheet.isSheetHidden(),
      dataRows: lastRow,
      dataCols: lastCol,
      allocatedCells: maxRow * maxCol,
      usedCells: lastRow * lastCol,
      formulaCount: 0,
      distinctFormulas: 0,
      volatileCount: 0,
      lookupCount: 0,
      importRangeCount: 0,
      queryCount: 0,
      arrayFormulaCount: 0,
      fullColumnRefs: 0,
      maxFormulaLength: 0,
      truncated: false
    };

    if (lastRow === 0 || lastCol === 0) {
      if (maxRow * maxCol > 10000) {
        findings.push(finding('LOW', 'Waste', name, '',
          'Empty tab holding ' + fmt(maxRow * maxCol) + ' allocated cells.',
          'Delete the tab or trim it to a few rows. Empty allocated cells count ' +
          'against the 10M-cell workbook limit.'));
      }
      return { summary: summary, findings: findings, importTargets: importTargets };
    }

    if (lastRow * lastCol > MAX_CELLS_PER_SHEET) {
      summary.truncated = true;
      findings.push(finding('MEDIUM', 'Scale', name, '',
        'Tab exceeds ' + fmt(MAX_CELLS_PER_SHEET) + ' cells (' + fmt(lastRow * lastCol) + '); scan truncated.',
        'A single tab this size is usually a transaction log that belongs in a ' +
        'snapshot table with closed periods written as values.'));
    }

    const scanRows = Math.min(lastRow, Math.floor(MAX_CELLS_PER_SHEET / Math.max(lastCol, 1)));
    const formulas = sheet.getRange(1, 1, scanRows, lastCol).getFormulas();
    const shapes = readShapes(sheet, scanRows, lastCol);

    const shapeCounts = {};   // normalised formula -> occurrences
    const shapeFirstCell = {}; // normalised formula -> first A1 seen
    const shapeSample = {};

    for (let r = 0; r < formulas.length; r++) {
      for (let c = 0; c < formulas[r].length; c++) {
        const f = formulas[r][c];
        if (!f) continue;

        summary.formulaCount++;
        summary.maxFormulaLength = Math.max(summary.maxFormulaLength, f.length);
        const a1 = cellA1(r + 1, c + 1);

        if (PATTERNS.volatile.test(f))      summary.volatileCount++;
        if (PATTERNS.positionalLookup.test(f)) summary.lookupCount++;
        if (PATTERNS.query.test(f))         summary.queryCount++;
        if (PATTERNS.arrayFormula.test(f))  summary.arrayFormulaCount++;
        if (PATTERNS.fullColumnRef.test(f)) summary.fullColumnRefs++;

        if (PATTERNS.importRange.test(f)) {
          summary.importRangeCount++;
          let m;
          PATTERNS.importRangeKey.lastIndex = 0;
          while ((m = PATTERNS.importRangeKey.exec(f)) !== null) {
            const key = shortKey(m[1]);
            importTargets[key] = (importTargets[key] || 0) + 1;
          }
        }

        const shape = shapes ? shapes[r][c] : normalise(f);
        if (shape) {
          shapeCounts[shape] = (shapeCounts[shape] || 0) + 1;
          if (!shapeFirstCell[shape]) {
            shapeFirstCell[shape] = a1;
            shapeSample[shape] = f;
          }
        }
      }
    }

    summary.distinctFormulas = Object.keys(shapeCounts).length;

    // ---- Findings derived from the distinct formula shapes -------------
    // Reporting per shape rather than per cell keeps the register readable:
    // 4,000 copies of one bad VLOOKUP is one decision, not 4,000.
    Object.keys(shapeCounts).forEach(function (shape) {
      const count = shapeCounts[shape];
      const f = shapeSample[shape];
      const at = shapeFirstCell[shape] + (count > 1 ? ' ×' + fmt(count) : '');

      if (PATTERNS.positionalLookup.test(f)) {
        findings.push(finding('HIGH', 'Fragility', name, at,
          'Positional lookup (VLOOKUP/HLOOKUP by column index).',
          'Returns the wrong column silently if a column is inserted in the source. ' +
          'Replace with INDEX/MATCH or XLOOKUP referencing the header by name.'));
      }

      if (PATTERNS.fullColumnRef.test(f) && !PATTERNS.arrayFormula.test(f)) {
        findings.push(finding(count >= FILL_DOWN_THRESHOLD ? 'HIGH' : 'MEDIUM', 'Performance', name, at,
          'Full-column reference (e.g. A:A) inside a filled-down formula.',
          'Each copy scans every row of the source. Bound the range, or collapse ' +
          'the column to one ARRAYFORMULA/QUERY in the header row.'));
      }

      if (PATTERNS.volatile.test(f)) {
        const which = (f.match(/\b(NOW|TODAY|RAND|RANDBETWEEN|INDIRECT|OFFSET)\b/i) || [])[0];
        findings.push(finding(count >= FILL_DOWN_THRESHOLD ? 'HIGH' : 'MEDIUM', 'Performance', name, at,
          'Volatile function ' + which + ' recalculates on every workbook edit.',
          which && /INDIRECT|OFFSET/i.test(which)
            ? 'INDIRECT/OFFSET also defeat dependency tracking and break silently on ' +
              'rename. Replace with a direct or named range.'
            : 'Compute once in a single helper cell and reference it, rather than ' +
              'repeating it down the column.'));
      }

      if (PATTERNS.blanketIfError.test(f) && PATTERNS.emptyFallback.test(f)) {
        findings.push(finding('HIGH', 'Data quality', name, at,
          'Blanket IFERROR(..., "") suppresses all errors to blank.',
          'A missing lookup and a broken reference now look identical to correct ' +
          'empty data. Return a typed marker such as "#NO_MATCH" and let the Data ' +
          'Health checks catch it.'));
      }

      if (PATTERNS.hardcodedDate.test(f)) {
        findings.push(finding('MEDIUM', 'Maintenance', name, at,
          'Hardcoded date embedded in a formula.',
          'Reporting periods should come from the Config tab so a new period is a ' +
          'row, not a formula edit across tabs.'));
      }

      if (count >= FILL_DOWN_THRESHOLD && !PATTERNS.arrayFormula.test(f)) {
        findings.push(finding('MEDIUM', 'Scale', name, at,
          'Identical formula filled down ' + fmt(count) + ' rows.',
          'Collapse to one ARRAYFORMULA or QUERY in the header row. Filled-down ' +
          'formulas stop at the last filled row, so new rows are silently uncalculated.'));
      }

      if (f.length > 300) {
        findings.push(finding('MEDIUM', 'Maintainability', name, at,
          'Formula is ' + fmt(f.length) + ' characters long.',
          'Split into named helper columns or move the logic to a script. Nobody ' +
          'can review this correctly, which is how errors survive for years.'));
      }

      const ifDepth = (f.match(/\bIF\s*\(/gi) || []).length;
      if (ifDepth >= 6) {
        findings.push(finding('MEDIUM', 'Maintainability', name, at,
          'Deeply nested IF (' + ifDepth + ' levels).',
          'Replace with a lookup table on the Config tab plus IFS/SWITCH, so the ' +
          'business rule is data rather than code.'));
      }
    });

    // ---- Formula extent vs data extent --------------------------------
    const trailing = trailingFormulaRows(formulas);
    if (trailing >= 100) {
      findings.push(finding('MEDIUM', 'Performance', name, 'rows ' + (scanRows - trailing + 1) + '-' + scanRows,
        fmt(trailing) + ' trailing rows contain formulas but no source data.',
        'These recalculate on every edit and produce nothing. Trim them, or ' +
        'convert the column to a self-extending ARRAYFORMULA.'));
    }

    if (summary.allocatedCells - summary.usedCells > 500000) {
      findings.push(finding('LOW', 'Waste', name, '',
        fmt(summary.allocatedCells - summary.usedCells) + ' allocated but unused cells.',
        'Delete unused rows/columns. Counts against the 10M-cell workbook limit.'));
    }

    return { summary: summary, findings: findings, importTargets: importTargets };
  }

  /* ------------------------------------------------------------------ *
   * Workbook-level scan
   * ------------------------------------------------------------------ */

  function auditWorkbookLevel(ss, summaries, importTargets) {
    const findings = [];

    const totalCells = summaries.reduce(function (a, s) { return a + s.allocatedCells; }, 0);
    if (totalCells > 5000000) {
      findings.push(finding('HIGH', 'Scale', '(workbook)', '',
        'Workbook holds ' + fmt(totalCells) + ' allocated cells (limit 10,000,000).',
        'Archive closed periods to a separate history workbook and keep only the ' +
        'open period live.'));
    }

    const distinctSources = Object.keys(importTargets);
    if (distinctSources.length) {
      const totalImports = distinctSources.reduce(function (a, k) { return a + importTargets[k]; }, 0);
      findings.push(finding(totalImports > 20 ? 'HIGH' : 'MEDIUM', 'Architecture', '(workbook)', '',
        fmt(totalImports) + ' IMPORTRANGE calls across ' + distinctSources.length + ' source workbook(s): ' +
        distinctSources.join(', ') + '.',
        'Each is an independent refresh with its own failure mode, and a failure ' +
        'upstream surfaces downstream as a blank cell rather than an error. ' +
        'Consolidate to one import per source into a raw landing tab, then read ' +
        'that tab internally.'));
    }

    // Triggers: what is scheduled, and is anything failing?
    let triggers = [];
    try {
      triggers = ScriptApp.getProjectTriggers();
    } catch (e) {
      Lib.log('WARN', 'Audit', 'Could not read triggers: ' + e);
    }
    if (!triggers.length) {
      findings.push(finding('MEDIUM', 'Automation', '(workbook)', '',
        'No installable triggers found in this script project.',
        'Any recurring task is therefore manual, or is scheduled under another ' +
        'user\'s account — confirm which, because triggers are owned by the user ' +
        'who created them and stop when that account is deactivated.'));
    } else {
      triggers.forEach(function (t) {
        findings.push(finding('INFO', 'Inventory', '(workbook)', '',
          'Trigger: ' + t.getHandlerFunction() + ' (' + t.getEventType() + ')',
          'Confirm this is still required and that its owner is a current employee.'));
      });
    }

    const named = ss.getNamedRanges();
    if (named.length === 0 && summaries.some(function (s) { return s.formulaCount > 500; })) {
      findings.push(finding('LOW', 'Maintainability', '(workbook)', '',
        'No named ranges defined in a heavily formula-driven workbook.',
        'Naming the handful of ranges that are referenced everywhere makes ' +
        'restructuring safe: move the range, and the references follow.'));
    }

    return findings;
  }

  /* ------------------------------------------------------------------ *
   * Report writing
   * ------------------------------------------------------------------ */

  function writeSummary(ss, summaries, started) {
    const sheet = ss.getSheetByName(SUMMARY_SHEET) || ss.insertSheet(SUMMARY_SHEET);
    const rows = [[
      'Tab', 'Hidden', 'Data rows', 'Data cols', 'Allocated cells', 'Formulas',
      'Distinct formulas', 'Volatile', 'V/HLOOKUP', 'IMPORTRANGE', 'QUERY',
      'ARRAYFORMULA', 'Full-col refs', 'Longest formula', 'Truncated scan'
    ]];

    summaries
      .sort(function (a, b) { return b.formulaCount - a.formulaCount; })
      .forEach(function (s) {
        rows.push([
          s.sheet, s.hidden ? 'Yes' : '', s.dataRows, s.dataCols, s.allocatedCells,
          s.formulaCount, s.distinctFormulas, s.volatileCount, s.lookupCount,
          s.importRangeCount, s.queryCount, s.arrayFormulaCount, s.fullColumnRefs,
          s.maxFormulaLength, s.truncated ? 'Yes' : ''
        ]);
      });

    rows.push([]);
    rows.push(['Scanned', new Date(), '', 'Duration (s)', ((Date.now() - started) / 1000).toFixed(1)]);

    Lib.writeTable(sheet, rows);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
    sheet.autoResizeColumns(1, rows[0].length);
  }

  function writeFindings(ss, findings) {
    const sheet = ss.getSheetByName(FINDINGS_SHEET) || ss.insertSheet(FINDINGS_SHEET);
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };

    findings.sort(function (a, b) {
      const d = order[a.severity] - order[b.severity];
      return d !== 0 ? d : a.category.localeCompare(b.category);
    });

    const rows = [['Severity', 'Category', 'Tab', 'Location', 'Finding', 'Recommendation']];
    findings.forEach(function (f) {
      rows.push([f.severity, f.category, f.sheet, f.location, f.finding, f.recommendation]);
    });

    Lib.writeTable(sheet, rows);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    sheet.setColumnWidth(5, 420);
    sheet.setColumnWidth(6, 520);
    sheet.getRange(2, 5, Math.max(rows.length - 1, 1), 2).setWrap(true);
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function finding(severity, category, sheet, location, text, recommendation) {
    return {
      severity: severity, category: category, sheet: sheet,
      location: location, finding: text, recommendation: recommendation
    };
  }

  /**
   * R1C1 formulas make "is this the same formula filled down?" a string
   * comparison. Falls back to stripping row numbers if unavailable.
   */
  function readShapes(sheet, rows, cols) {
    try {
      return sheet.getRange(1, 1, rows, cols).getFormulasR1C1();
    } catch (e) {
      return null;
    }
  }

  /** Fallback shape normaliser: A1 formula with row numbers removed. */
  function normalise(formula) {
    return formula.replace(/(\$?[A-Z]{1,3})\$?\d+/g, '$1#');
  }

  /** Counts trailing rows that hold formulas but whose first column is empty. */
  function trailingFormulaRows(formulas) {
    let count = 0;
    for (let r = formulas.length - 1; r >= 0; r--) {
      const row = formulas[r];
      const hasFormula = row.some(function (f) { return !!f; });
      if (!hasFormula) break;
      // A row whose leading columns are all formulas and which sits below the
      // data is the classic "dragged the formula to row 10,000" pattern.
      const leadingFilled = row[0] !== '';
      if (!leadingFilled) break;
      count++;
      if (count > 20000) break;
    }
    return count;
  }

  function cellA1(row, col) {
    let s = '';
    let c = col;
    while (c > 0) {
      const rem = (c - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      c = Math.floor((c - 1) / 26);
    }
    return s + row;
  }

  function shortKey(urlOrKey) {
    const m = String(urlOrKey).match(/\/d\/([a-zA-Z0-9-_]+)/);
    const key = m ? m[1] : String(urlOrKey);
    return key.length > 14 ? key.slice(0, 8) + '…' + key.slice(-4) : key;
  }

  function fmt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  return {
    auditWorkbook: auditWorkbook,
    SUMMARY_SHEET: SUMMARY_SHEET,
    FINDINGS_SHEET: FINDINGS_SHEET
  };
})();

/** Menu-callable wrapper. */
function auditWorkbook() {
  return Audit.auditWorkbook();
}
