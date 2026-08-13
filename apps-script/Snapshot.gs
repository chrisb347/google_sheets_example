/**
 * Snapshot.gs — the change that recovered most of the recalculation time.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * The inherited system recalculated all history, continuously. Every agent-week
 * metric for every period since 2023 was a live formula reading the full deal
 * log. Editing one cell anywhere in the workbook re-derived three years of
 * closed history that had not changed and could not change.
 *
 * Roughly 90% of recalculation cost was spent recomputing settled facts.
 *
 * THE FIX
 * -------
 * A period is either OPEN (still receiving data, recomputed on each run) or
 * CLOSED (settled, written once as values, never touched again). The mart holds
 * both, but only the open period is ever recomputed. Dashboards read the mart —
 * a flat, indexed table — instead of reaching back into the deal log.
 *
 * Closing a period is deliberate and reversible: `reopenPeriod()` exists because
 * late adjustments are a business reality, and the answer to that is a
 * controlled reopen, not leaving everything live forever.
 *
 * Mart schema (Mart_AgentWeek)
 *   PeriodKey | AgentId | AgentName | TeamId | TeamName | Deals | Revenue |
 *   NewLogos | Target | AttainmentPct | Status | ComputedAt
 */

const Snapshot = (function () {

  /**
   * Rebuilds the open period and leaves closed periods untouched.
   * @return {!Object} { periodKey, agentRows, revenue }
   */
  function refreshOpenPeriod() {
    return Lib.withLock('Snapshot.refreshOpenPeriod', function () {
      const openPeriod = Config.get('OpenPeriodKey');
      const martSheet = Lib.mustGetSheet(Config.get('MartSheetTab', 'Mart_AgentWeek'));

      const existing = Lib.readObjects(martSheet);
      const closed = existing.filter(function (r) {
        return String(r.Status).toUpperCase() === 'CLOSED' &&
               Lib.normKey(r.PeriodKey) !== Lib.normKey(openPeriod);
      });

      const fresh = computePeriod(openPeriod, 'OPEN');

      writeMart(martSheet, closed.concat(fresh));

      const revenue = fresh.reduce(function (a, r) { return a + r.Revenue; }, 0);
      Lib.log('INFO', 'Snapshot',
        'Refreshed ' + openPeriod + ': ' + fresh.length + ' agent rows, ' + revenue.toFixed(2) + ' revenue. ' +
        closed.length + ' closed rows preserved as values.');

      return { periodKey: openPeriod, agentRows: fresh.length, revenue: revenue };
    });
  }

  /**
   * Freezes the open period as CLOSED and advances Config to the next period.
   * After this, nothing recalculates that period again.
   *
   * @param {string=} periodKey Defaults to the current open period.
   * @return {!Object}
   */
  function closePeriod(periodKey) {
    return Lib.withLock('Snapshot.closePeriod', function () {
      const period = periodKey || Config.get('OpenPeriodKey');

      // Never close over bad data — a closed period is expensive to correct.
      DataHealth.assertHealthy();

      const martSheet = Lib.mustGetSheet(Config.get('MartSheetTab', 'Mart_AgentWeek'));
      const existing = Lib.readObjects(martSheet);

      const others = existing.filter(function (r) {
        return Lib.normKey(r.PeriodKey) !== Lib.normKey(period);
      });
      const closedRows = computePeriod(period, 'CLOSED');

      writeMart(martSheet, others.concat(closedRows));
      archive(closedRows);
      advanceOpenPeriod(period);

      Lib.log('INFO', 'Snapshot', 'Closed ' + period + ' (' + closedRows.length + ' rows) and advanced open period.');
      return { periodKey: period, rows: closedRows.length };
    });
  }

  /**
   * Reopens a closed period so a late adjustment can flow through. Deliberately
   * separate and logged — reopening is an event people should be able to see.
   *
   * @param {string} periodKey
   */
  function reopenPeriod(periodKey) {
    return Lib.withLock('Snapshot.reopenPeriod', function () {
      if (!periodKey) throw new Error('reopenPeriod requires a period key, e.g. "2026-W07".');

      const martSheet = Lib.mustGetSheet(Config.get('MartSheetTab', 'Mart_AgentWeek'));
      const rows = Lib.readObjects(martSheet);
      let touched = 0;

      rows.forEach(function (r) {
        if (Lib.normKey(r.PeriodKey) === Lib.normKey(periodKey)) {
          r.Status = 'OPEN';
          touched++;
        }
      });
      if (!touched) throw new Error('No mart rows found for period "' + periodKey + '".');

      writeMart(martSheet, rows);
      setSetting('OpenPeriodKey', periodKey);

      Lib.log('WARN', 'Snapshot', 'REOPENED ' + periodKey + ' (' + touched + ' rows) — ' +
        'published figures for this period may now change.');
      return { periodKey: periodKey, rows: touched };
    });
  }

  /* ------------------------------------------------------------------ *
   * Computation
   * ------------------------------------------------------------------ */

  /**
   * Aggregates the deal log into agent-period rows, in memory.
   *
   * One pass over the raw data with hash joins, rather than the previous
   * SUMIFS-per-agent-per-metric pattern (which was O(agents × metrics × rows)
   * and re-scanned the entire log for every cell).
   *
   * @param {string} periodKey
   * @param {string} status OPEN | CLOSED
   * @return {!Array<!Object>}
   */
  function computePeriod(periodKey, status) {
    const raw = Lib.readObjects(Lib.mustGetSheet(Config.get('RawSalesTab', 'Raw_Sales')));
    const agents = Config.agentIndex();
    const teams = Config.teamIndex();
    const targets = Config.targetIndex();
    const wanted = Lib.normKey(periodKey);

    const acc = {};

    raw.forEach(function (row) {
      if (Lib.normKey(row.PeriodKey) !== wanted) return;

      const agentKey = Lib.normKey(row.AgentId);
      const agent = agents[agentKey];
      if (!agent) return; // Surfaced as a BLOCKER by DataHealth.checkOrphanAgents

      if (!acc[agentKey]) {
        const team = teams[Lib.normKey(agent.TeamId)] || {};
        acc[agentKey] = {
          PeriodKey: periodKey,
          AgentId: agent.AgentId,
          AgentName: agent.AgentName,
          TeamId: agent.TeamId,
          TeamName: team.TeamName || agent.TeamId,
          Deals: 0,
          Revenue: 0,
          NewLogos: 0
        };
      }

      const bucket = acc[agentKey];
      bucket.Deals += 1;
      bucket.Revenue += Number(row.Amount) || 0;
      if (String(row.DealType).toLowerCase() === 'new') bucket.NewLogos += 1;
    });

    // Every active agent appears, including those with no deals. The old system
    // omitted them, which quietly flattered team averages.
    Config.activeAgents().forEach(function (agent) {
      const key = Lib.normKey(agent.AgentId);
      if (acc[key]) return;
      const team = teams[Lib.normKey(agent.TeamId)] || {};
      acc[key] = {
        PeriodKey: periodKey,
        AgentId: agent.AgentId,
        AgentName: agent.AgentName,
        TeamId: agent.TeamId,
        TeamName: team.TeamName || agent.TeamId,
        Deals: 0, Revenue: 0, NewLogos: 0
      };
    });

    const now = new Date();
    return Object.keys(acc).map(function (k) {
      const row = acc[k];
      const targetKey = [periodKey, 'AGENT', row.AgentId, 'Revenue'].map(Lib.normKey).join('|');
      const target = targets[targetKey] || 0;
      row.Target = target;
      row.AttainmentPct = target > 0 ? row.Revenue / target : '';
      row.Status = status;
      row.ComputedAt = now;
      return row;
    }).sort(function (a, b) {
      return a.PeriodKey === b.PeriodKey
        ? String(a.AgentId).localeCompare(String(b.AgentId))
        : String(a.PeriodKey).localeCompare(String(b.PeriodKey));
    });
  }

  /* ------------------------------------------------------------------ *
   * Persistence
   * ------------------------------------------------------------------ */

  const COLUMNS = ['PeriodKey', 'AgentId', 'AgentName', 'TeamId', 'TeamName',
                   'Deals', 'Revenue', 'NewLogos', 'Target', 'AttainmentPct',
                   'Status', 'ComputedAt'];

  function writeMart(sheet, rows) {
    const table = [COLUMNS.slice()];
    rows.forEach(function (r) {
      table.push(COLUMNS.map(function (c) {
        return r[c] === undefined || r[c] === null ? '' : r[c];
      }));
    });
    Lib.writeTable(sheet, table);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');

    const dataRows = Math.max(table.length - 1, 1);
    sheet.getRange(2, 7, dataRows, 1).setNumberFormat('$#,##0.00');   // Revenue
    sheet.getRange(2, 9, dataRows, 1).setNumberFormat('$#,##0.00');   // Target
    sheet.getRange(2, 10, dataRows, 1).setNumberFormat('0.0%');       // Attainment
  }

  /**
   * Appends closed rows to the history workbook, which keeps the live workbook
   * small. History is append-only; nothing ever rewrites it.
   */
  function archive(rows) {
    const archiveId = Config.get('ArchiveSpreadsheetId', '');
    if (!archiveId || !rows.length) return;

    Lib.retry(function () {
      const book = SpreadsheetApp.openById(archiveId);
      const tab = book.getSheetByName('History') || book.insertSheet('History');
      if (tab.getLastRow() === 0) {
        tab.appendRow(COLUMNS);
        tab.setFrozenRows(1);
      }
      const values = rows.map(function (r) {
        return COLUMNS.map(function (c) { return r[c] === undefined ? '' : r[c]; });
      });
      tab.getRange(tab.getLastRow() + 1, 1, values.length, COLUMNS.length).setValues(values);
    });
  }

  /* ------------------------------------------------------------------ *
   * Period arithmetic
   * ------------------------------------------------------------------ */

  /** Advances OpenPeriodKey to the ISO week following the one just closed. */
  function advanceOpenPeriod(closedPeriod) {
    const match = String(closedPeriod).match(/^(\d{4})-W(\d{1,2})$/);
    if (!match) {
      Lib.log('WARN', 'Snapshot',
        'Period "' + closedPeriod + '" is not in yyyy-Www form; set OpenPeriodKey manually.');
      return;
    }
    // Derive from the actual calendar rather than incrementing the number, so
    // 52/53-week years are handled correctly.
    const thursday = isoWeekThursday(Number(match[1]), Number(match[2]));
    thursday.setDate(thursday.getDate() + 7);
    setSetting('OpenPeriodKey', Lib.isoWeek(thursday));
  }

  function isoWeekThursday(year, week) {
    const jan4 = new Date(year, 0, 4);
    const dayNum = jan4.getDay() || 7;
    const week1Monday = new Date(year, 0, 4 - dayNum + 1);
    return new Date(week1Monday.getFullYear(), week1Monday.getMonth(),
                    week1Monday.getDate() + (week - 1) * 7 + 3);
  }

  /** Writes a single key back to the Config tab. */
  function setSetting(key, value) {
    const sheet = Lib.mustGetSheet(Config.SHEETS.config);
    const values = sheet.getDataRange().getValues();
    for (let r = 1; r < values.length; r++) {
      if (String(values[r][0]).trim() === key) {
        sheet.getRange(r + 1, 2).setValue(value);
        Config.flush();
        return;
      }
    }
    sheet.appendRow([key, value, 'Added automatically by Snapshot']);
    Config.flush();
  }

  return {
    refreshOpenPeriod: refreshOpenPeriod,
    closePeriod: closePeriod,
    reopenPeriod: reopenPeriod,
    computePeriod: computePeriod
  };
})();

/** Menu- and trigger-callable wrappers. */
function refreshOpenPeriod() { return Snapshot.refreshOpenPeriod(); }
function closeCurrentPeriod() { return Snapshot.closePeriod(); }
