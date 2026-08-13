/**
 * DataHealth.gs — rule-driven validation with a visible status tab.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * The inherited system had no concept of "wrong". It had blank cells. A failed
 * IMPORTRANGE, an agent ID that didn't match the roster, a deal logged twice,
 * and a genuinely quiet week all rendered identically: a blank, or a zero. The
 * numbers were found to be wrong by a person, in a meeting, after they had been
 * used.
 *
 * The rule here is: every assumption the reporting depends on becomes a check
 * that fails loudly. Checks run before the weekly close, and the close refuses
 * to run if a BLOCKER fails — it is much cheaper to be late than to be wrong.
 *
 * Severity levels
 *   BLOCKER  reporting would be incorrect; the close is halted
 *   WARN     worth a human look; the close proceeds
 *   INFO     recorded for trend only
 */

const DataHealth = (function () {

  const STATUS_SHEET = 'Data Health';

  /* ------------------------------------------------------------------ *
   * Check registry
   * ------------------------------------------------------------------ */

  /**
   * Each check returns { pass, detail, rows } where rows is an optional list of
   * offending record identifiers, capped for readability.
   */
  const CHECKS = [
    { id: 'REQ_FIELDS',   name: 'Required fields present',        severity: 'BLOCKER', fn: checkRequiredFields },
    { id: 'ORPHAN_AGENT', name: 'Every AgentId exists in roster',  severity: 'BLOCKER', fn: checkOrphanAgents },
    { id: 'DUP_DEAL',     name: 'No duplicate DealId',             severity: 'BLOCKER', fn: checkDuplicateDeals },
    { id: 'RECONCILE',    name: 'Mart total reconciles to raw',    severity: 'BLOCKER', fn: checkReconciliation },
    { id: 'ERROR_CELLS',  name: 'No error values in key tabs',     severity: 'BLOCKER', fn: checkErrorCells },
    { id: 'STALE_IMPORT', name: 'Imported data is current',        severity: 'WARN',    fn: checkStaleImport },
    { id: 'VOLUME',       name: 'Row volume within normal range',  severity: 'WARN',    fn: checkVolumeAnomaly },
    { id: 'DATE_RANGE',   name: 'No future-dated or ancient deals',severity: 'WARN',    fn: checkDateSanity },
    { id: 'TARGETS',      name: 'Targets exist for open period',   severity: 'WARN',    fn: checkTargetsPresent }
  ];

  /* ------------------------------------------------------------------ *
   * Runner
   * ------------------------------------------------------------------ */

  /**
   * Runs every check, writes the status tab, alerts on failure.
   * @return {!Object} { ok, blockers, warnings, results }
   */
  function runAll() {
    return Lib.withLock('DataHealth.runAll', function () {
      const ctx = buildContext();
      const results = CHECKS.map(function (check) {
        let outcome;
        try {
          outcome = check.fn(ctx) || { pass: false, detail: 'Check returned nothing.' };
        } catch (err) {
          outcome = { pass: false, detail: 'Check errored: ' + (err && err.message ? err.message : err) };
        }
        return {
          id: check.id,
          name: check.name,
          severity: check.severity,
          pass: !!outcome.pass,
          detail: outcome.detail || '',
          rows: outcome.rows || []
        };
      });

      const blockers = results.filter(function (r) { return !r.pass && r.severity === 'BLOCKER'; });
      const warnings = results.filter(function (r) { return !r.pass && r.severity === 'WARN'; });

      writeStatus(results);

      if (blockers.length || warnings.length) {
        notify(blockers, warnings);
      }

      Lib.log(blockers.length ? 'ERROR' : 'INFO', 'DataHealth',
        blockers.length + ' blocker(s), ' + warnings.length + ' warning(s)');

      return { ok: blockers.length === 0, blockers: blockers, warnings: warnings, results: results };
    });
  }

  /**
   * Pre-flight guard. Called by the weekly close before it writes anything.
   * @throws {Error} if any BLOCKER check fails.
   */
  function assertHealthy() {
    const status = runAll();
    if (!status.ok) {
      throw new Error(
        'Weekly close halted — ' + status.blockers.length + ' blocking data issue(s):\n' +
        status.blockers.map(function (b) { return '  • ' + b.name + ': ' + b.detail; }).join('\n') +
        '\n\nSee the "Data Health" tab. Fix the source data and re-run.');
    }
    return status;
  }

  /* ------------------------------------------------------------------ *
   * Context — read every source once, not once per check
   * ------------------------------------------------------------------ */

  function buildContext() {
    const rawSheetName = Config.get('RawSalesTab', 'Raw_Sales');
    const martSheetName = Config.get('MartSheetTab', 'Mart_AgentWeek');
    const raw = Lib.readObjects(Lib.mustGetSheet(rawSheetName));

    return {
      raw: raw,
      rawSheetName: rawSheetName,
      martSheetName: martSheetName,
      agents: Config.agentIndex(),
      teams: Config.teamIndex(),
      targets: Config.targetIndex(),
      openPeriod: Config.get('OpenPeriodKey'),
      now: new Date()
    };
  }

  /* ------------------------------------------------------------------ *
   * Checks
   * ------------------------------------------------------------------ */

  function checkRequiredFields(ctx) {
    const required = Config.getList('RequiredDealFields', 'DealId,AgentId,CloseDate,Amount');
    const bad = [];
    ctx.raw.forEach(function (row, i) {
      const missing = required.filter(function (f) {
        return row[f] === '' || row[f] === null || row[f] === undefined;
      });
      if (missing.length) bad.push(rowRef(i) + ' missing ' + missing.join('/'));
    });
    return {
      pass: bad.length === 0,
      detail: bad.length ? bad.length + ' row(s) missing required fields.' : 'All rows complete.',
      rows: bad
    };
  }

  function checkOrphanAgents(ctx) {
    const seen = {};
    const bad = [];
    ctx.raw.forEach(function (row, i) {
      const key = Lib.normKey(row.AgentId);
      if (!key) return; // handled by REQ_FIELDS
      if (!ctx.agents[key] && !seen[key]) {
        seen[key] = true;
        bad.push('"' + row.AgentId + '" (first at ' + rowRef(i) + ')');
      }
    });
    return {
      pass: bad.length === 0,
      detail: bad.length
        ? bad.length + ' AgentId value(s) not present on the Agents tab. Their revenue ' +
          'is excluded from every team and company rollup.'
        : 'All AgentIds resolve to the roster.',
      rows: bad
    };
  }

  function checkDuplicateDeals(ctx) {
    const seen = {};
    const dupes = [];
    ctx.raw.forEach(function (row, i) {
      const key = Lib.normKey(row.DealId);
      if (!key) return;
      if (seen[key] !== undefined) {
        dupes.push('DealId ' + row.DealId + ' at ' + rowRef(i) + ' (first ' + rowRef(seen[key]) + ')');
      } else {
        seen[key] = i;
      }
    });
    return {
      pass: dupes.length === 0,
      detail: dupes.length ? dupes.length + ' duplicate DealId(s) — revenue is double-counted.' : 'DealId is unique.',
      rows: dupes
    };
  }

  /**
   * The check that matters most: does the published mart still equal the raw
   * data it claims to summarise? Everything else is a proxy for this.
   */
  function checkReconciliation(ctx) {
    const tolerance = Config.getNumber('ReconcileToleranceAbs', 0.01);
    const period = Lib.normKey(ctx.openPeriod);

    let rawTotal = 0;
    ctx.raw.forEach(function (row) {
      if (Lib.normKey(row.PeriodKey) === period) rawTotal += Number(row.Amount) || 0;
    });

    const mart = Lib.readObjects(Lib.mustGetSheet(ctx.martSheetName));
    let martTotal = 0;
    mart.forEach(function (row) {
      if (Lib.normKey(row.PeriodKey) === period) martTotal += Number(row.Revenue) || 0;
    });

    const delta = Math.abs(rawTotal - martTotal);
    return {
      pass: delta <= tolerance,
      detail: 'Raw ' + money(rawTotal) + ' vs mart ' + money(martTotal) +
              ' for ' + ctx.openPeriod + ' (delta ' + money(delta) + ', tolerance ' + money(tolerance) + ').',
      rows: []
    };
  }

  function checkErrorCells(ctx) {
    const tabs = Config.getList('ErrorScanTabs', ctx.rawSheetName + ',' + ctx.martSheetName);
    const errorPattern = /^#(REF|N\/A|VALUE|DIV\/0|NAME|NUM|ERROR)[!?]?/;
    const found = [];

    tabs.forEach(function (tabName) {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
      if (!sheet) { found.push('Tab "' + tabName + '" not found'); return; }
      if (sheet.getLastRow() === 0) return;

      const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getDisplayValues();
      for (let r = 0; r < values.length && found.length < 25; r++) {
        for (let c = 0; c < values[r].length; c++) {
          if (errorPattern.test(String(values[r][c]))) {
            found.push(tabName + '!R' + (r + 1) + 'C' + (c + 1) + ' = ' + values[r][c]);
            break;
          }
        }
      }
    });

    return {
      pass: found.length === 0,
      detail: found.length ? found.length + '+ cell(s) evaluate to an error.' : 'No error values.',
      rows: found
    };
  }

  function checkStaleImport(ctx) {
    const maxAgeHours = Config.getNumber('MaxImportAgeHours', 26);
    let newest = null;
    ctx.raw.forEach(function (row) {
      const d = row.ImportedAt instanceof Date ? row.ImportedAt
              : (row.CloseDate instanceof Date ? row.CloseDate : null);
      if (d && (!newest || d > newest)) newest = d;
    });
    if (!newest) return { pass: false, detail: 'No timestamps found in ' + ctx.rawSheetName + '.' };

    const ageHours = (ctx.now - newest) / 36e5;
    return {
      pass: ageHours <= maxAgeHours,
      detail: 'Most recent record is ' + ageHours.toFixed(1) + 'h old (threshold ' + maxAgeHours + 'h). ' +
              (ageHours > maxAgeHours ? 'The upstream import has probably failed silently.' : ''),
      rows: []
    };
  }

  /**
   * Volume anomaly: a sudden collapse in row count is the signature of a
   * partially-failed import, which otherwise looks like a bad sales week.
   */
  function checkVolumeAnomaly(ctx) {
    const history = Lib.readObjects(Lib.mustGetSheet(Config.get('HealthHistoryTab', '_Health History')));
    const recent = history.slice(-8).map(function (h) { return Number(h.RawRowCount) || 0; })
                          .filter(function (n) { return n > 0; });
    const current = ctx.raw.length;

    if (recent.length < 3) {
      return { pass: true, detail: 'Baseline still building (' + recent.length + ' prior runs).' };
    }
    const mean = recent.reduce(function (a, b) { return a + b; }, 0) / recent.length;
    const deviation = mean === 0 ? 0 : (current - mean) / mean;
    const threshold = Config.getNumber('VolumeDeviationThreshold', 0.4);

    return {
      pass: Math.abs(deviation) <= threshold,
      detail: current + ' rows vs ' + mean.toFixed(0) + ' recent average (' +
              (deviation * 100).toFixed(0) + '%). ' +
              (deviation < -threshold ? 'A drop this size usually means a truncated import, not a quiet week.' : ''),
      rows: []
    };
  }

  function checkDateSanity(ctx) {
    const bad = [];
    const horizon = new Date(ctx.now.getTime() + 24 * 36e5);
    const floor = new Date(ctx.now.getFullYear() - 5, 0, 1);

    ctx.raw.forEach(function (row, i) {
      const d = row.CloseDate;
      if (!(d instanceof Date)) {
        if (d !== '' && d !== null && d !== undefined) {
          bad.push(rowRef(i) + ' CloseDate is text, not a date: "' + d + '"');
        }
        return;
      }
      if (d > horizon) bad.push(rowRef(i) + ' CloseDate is in the future: ' + d.toDateString());
      if (d < floor)   bad.push(rowRef(i) + ' CloseDate is implausibly old: ' + d.toDateString());
    });

    return {
      pass: bad.length === 0,
      detail: bad.length ? bad.length + ' row(s) with suspect dates. Text-formatted dates ' +
                           'silently drop out of every period filter.' : 'Dates are sane and typed.',
      rows: bad.slice(0, 25)
    };
  }

  function checkTargetsPresent(ctx) {
    const missing = [];
    Config.activeTeams().forEach(function (t) {
      const key = [ctx.openPeriod, 'TEAM', t.TeamId, 'Revenue'].map(Lib.normKey).join('|');
      if (ctx.targets[key] === undefined) missing.push(t.TeamName || t.TeamId);
    });
    return {
      pass: missing.length === 0,
      detail: missing.length
        ? 'No ' + ctx.openPeriod + ' revenue target for: ' + missing.join(', ') +
          '. Attainment % will show as blank or 0 on the dashboard.'
        : 'All active teams have a target for ' + ctx.openPeriod + '.',
      rows: missing
    };
  }

  /* ------------------------------------------------------------------ *
   * Output
   * ------------------------------------------------------------------ */

  function writeStatus(results) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(STATUS_SHEET) || ss.insertSheet(STATUS_SHEET, 0);

    const rows = [['Status', 'Severity', 'Check', 'Detail', 'Examples']];
    results.forEach(function (r) {
      rows.push([
        r.pass ? 'PASS' : 'FAIL',
        r.severity,
        r.name,
        r.detail,
        r.rows.slice(0, 5).join(' | ') + (r.rows.length > 5 ? ' … +' + (r.rows.length - 5) + ' more' : '')
      ]);
    });
    rows.push([]);
    rows.push(['Last run', new Date()]);

    Lib.writeTable(sheet, rows);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    sheet.setColumnWidth(4, 460);
    sheet.setColumnWidth(5, 460);
    sheet.getRange(2, 4, Math.max(rows.length - 1, 1), 2).setWrap(true);

    // Status colouring is the whole point: the tab should be readable at a
    // glance from across a room, because that is how it actually gets checked.
    const statusRange = sheet.getRange(2, 1, results.length, 1);
    statusRange.setBackgrounds(results.map(function (r) {
      return [r.pass ? '#d9ead3' : (r.severity === 'BLOCKER' ? '#f4cccc' : '#fce5cd')];
    }));

    appendHistory(results);
  }

  function appendHistory(results) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const name = Config.get('HealthHistoryTab', '_Health History');
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(['RunAt', 'RawRowCount', 'Blockers', 'Warnings']);
      sheet.setFrozenRows(1);
      sheet.hideSheet();
    }
    const raw = Lib.readObjects(Lib.mustGetSheet(Config.get('RawSalesTab', 'Raw_Sales')));
    sheet.appendRow([
      new Date(),
      raw.length,
      results.filter(function (r) { return !r.pass && r.severity === 'BLOCKER'; }).length,
      results.filter(function (r) { return !r.pass && r.severity === 'WARN'; }).length
    ]);
  }

  function notify(blockers, warnings) {
    const recipients = Config.getList('AlertRecipients', '');
    if (!recipients.length) return;

    const lines = [];
    if (blockers.length) {
      lines.push('BLOCKING (reporting would be incorrect):');
      blockers.forEach(function (b) {
        lines.push('  • ' + b.name + ' — ' + b.detail);
        b.rows.slice(0, 5).forEach(function (r) { lines.push('      ' + r); });
      });
      lines.push('');
    }
    if (warnings.length) {
      lines.push('WARNINGS (review before publishing):');
      warnings.forEach(function (w) { lines.push('  • ' + w.name + ' — ' + w.detail); });
    }

    Lib.alert(
      (blockers.length ? '[BLOCKED] ' : '[WARN] ') + 'Sales data health — ' +
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
      lines.join('\n'),
      recipients);
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  /** Data row index -> spreadsheet row number (header occupies row 1). */
  function rowRef(index) { return 'row ' + (index + 2); }

  function money(n) {
    return (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  return {
    runAll: runAll,
    assertHealthy: assertHealthy,
    STATUS_SHEET: STATUS_SHEET
  };
})();

/** Menu- and trigger-callable wrappers. */
function runDataHealth() { return DataHealth.runAll(); }
