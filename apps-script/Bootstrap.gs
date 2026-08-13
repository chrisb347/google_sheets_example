/**
 * Bootstrap.gs — turns an empty spreadsheet into a working demo system.
 *
 * Run `bootstrapDemo()` once and you get every tab, realistic seeded data, a
 * populated mart, and live rankings. Roughly 30 seconds.
 *
 * This exists because a reference build nobody can run is just a screenshot.
 *
 * The demo narrative it is designed to support:
 *
 *   1. bootstrapDemo()          → clean system; run the close, everything green
 *   2. injectDemoFaults()       → four realistic data problems, of the exact
 *                                 kinds that used to publish silently
 *   3. Run data health checks   → blockers fire, naming rows and IDs
 *   4. Try to close the week    → refuses to run, and says why
 *   5. repairDemoFaults()       → green again
 *
 * Step 4 is the one worth showing. The point of the system is not that it is
 * fast; it is that a wrong number cannot reach a report unnoticed.
 *
 * Data is generated from a fixed seed, so every run produces identical
 * numbers — which means a demo can be rehearsed, and two people looking at
 * two copies are looking at the same figures.
 *
 * SAFETY: bootstrapDemo() refuses to run if the tabs already hold data, so it
 * cannot be pointed at a real workbook by accident.
 */

const Bootstrap = (function () {

  const WEEKS = 6;              // periods of history to generate
  const SEED = 20260213;        // fixed → reproducible output

  const TEAMS = [
    ['T-NORTH', 'North',     'R-US', 'north.lead@example.com',     true],
    ['T-SOUTH', 'South',     'R-US', 'south.lead@example.com',     true],
    ['T-EAST',  'East',      'R-EU', 'east.lead@example.com',      true],
    ['T-WEST',  'West',      'R-EU', 'west.lead@example.com',      true],
    ['T-ENT',   'Enterprise','R-US', 'ent.lead@example.com',       true],
    ['T-LEGACY','Legacy',    'R-US', 'legacy.lead@example.com',    false]
  ];

  const FIRST = ['Ava','Noah','Mia','Liam','Zoe','Ethan','Iris','Owen','Nina','Kai',
                 'Rosa','Theo','Juno','Milo','Elsa','Hugo','Lena','Finn','Cleo','Otis',
                 'Vera','Jude','Maya','Ari'];
  const LAST  = ['Okafor','Novak','Reyes','Haddad','Lindqvist','Osei','Marchetti','Duval',
                 'Kowalski','Nakamura','Silva','Bauer','Ferreira','Adeyemi','Larsen','Costa',
                 'Petrov','Ibrahim','Moreau','Vance','Ellis','Rahman','Quinn','Torres'];

  /* ------------------------------------------------------------------ *
   * Entry points
   * ------------------------------------------------------------------ */

  /**
   * Creates and populates everything. Idempotent only in the sense that it
   * refuses to run twice — it will not silently overwrite existing data.
   *
   * @param {boolean=} force Set true to wipe and rebuild.
   * @return {string} summary
   */
  function bootstrapDemo(force) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (!force && hasExistingData(ss)) {
      throw new Error(
        'This spreadsheet already contains data on one of the system tabs.\n\n' +
        'bootstrapDemo() will not overwrite it. If this really is a scratch ' +
        'demo file, run bootstrapDemo(true) from the editor to rebuild.');
    }

    const periods = recentPeriods(WEEKS);
    const openPeriod = periods[periods.length - 1];

    const teams = buildTeams();
    const agents = buildAgents(teams);
    const deals = buildDeals(agents, periods);
    const targets = buildTargets(teams, agents, periods);

    writeTab(ss, 'Config',   configRows(openPeriod));
    writeTab(ss, 'Teams',    [['TeamId', 'TeamName', 'RegionId', 'ManagerEmail', 'Active']].concat(teams));
    writeTab(ss, 'Agents',   [['AgentId', 'AgentName', 'TeamId', 'StartDate', 'EndDate', 'Active']].concat(agents));
    writeTab(ss, 'Targets',  [['PeriodKey', 'ScopeType', 'ScopeId', 'Metric', 'TargetValue']].concat(targets));
    writeTab(ss, 'Raw_Sales',[['DealId', 'AgentId', 'DealType', 'CloseDate', 'PeriodKey', 'Amount', 'ImportedAt']].concat(deals));
    writeTab(ss, 'Mart_AgentWeek', [['PeriodKey', 'AgentId', 'AgentName', 'TeamId', 'TeamName',
                                     'Deals', 'Revenue', 'NewLogos', 'Target', 'AttainmentPct',
                                     'Status', 'ComputedAt']]);

    formatInputTabs(ss);
    Config.flush();

    // Build the closed history first, so rankings have prior periods to show
    // movement against — a demo with no movement column is a poor demo.
    periods.slice(0, -1).forEach(function (p) {
      const rows = Snapshot.computePeriod(p, 'CLOSED');
      appendMart(ss, rows);
    });

    Snapshot.refreshOpenPeriod();
    Rankings.rebuild(openPeriod);
    DataHealth.runAll();

    const summary =
      'Demo system built.\n\n' +
      '  ' + teams.length + ' teams (1 inactive)\n' +
      '  ' + agents.length + ' agents (2 end-dated)\n' +
      '  ' + deals.length + ' deals across ' + WEEKS + ' weeks\n' +
      '  Periods ' + periods[0] + ' → ' + openPeriod + '\n' +
      '  ' + openPeriod + ' is OPEN; the rest are CLOSED\n\n' +
      'Look at: Rankings, Mart_AgentWeek, Data Health.\n' +
      'Then try Demo → Inject data faults.';

    Lib.log('INFO', 'Bootstrap', 'Built demo: ' + agents.length + ' agents, ' + deals.length + ' deals');
    return summary;
  }

  /**
   * Adds four data problems of the kinds that used to publish silently.
   * Each maps to a specific BLOCKER check.
   *
   * @return {string} summary
   */
  function injectDemoFaults() {
    const sheet = Lib.mustGetSheet(Config.get('RawSalesTab', 'Raw_Sales'));
    const openPeriod = Config.get('OpenPeriodKey');
    const monday = mondayOf(openPeriod);
    const now = new Date();

    const existing = Lib.readObjects(sheet);
    if (!existing.length) throw new Error('No data in Raw_Sales — run the bootstrap first.');
    const sample = existing[0];

    const faults = [
      // 1. ORPHAN_AGENT — an ID that is not on the roster. Their revenue is
      //    silently excluded from every team and company rollup.
      ['D-FAULT-1', 'AG-999', 'New', monday, openPeriod, 14500, now],

      // 2. DUP_DEAL — the same deal logged twice. Revenue double-counts.
      [sample.DealId, sample.AgentId, sample.DealType, sample.CloseDate,
       sample.PeriodKey, sample.Amount, now],

      // 3. DATE_RANGE — a date stored as text. Drops out of every period
      //    filter, so the period total is quietly short.
      ['D-FAULT-3', existing[1].AgentId, 'Renewal',
       Utilities.formatDate(monday, Session.getScriptTimeZone(), 'MM/dd/yyyy'),
       openPeriod, 9200, now],

      // 4. REQ_FIELDS — a missing amount.
      ['D-FAULT-4', existing[2].AgentId, 'New', monday, openPeriod, '', now]
    ];

    sheet.getRange(sheet.getLastRow() + 1, 1, faults.length, 7).setValues(faults);
    Config.flush();

    const status = DataHealth.runAll();

    Lib.log('WARN', 'Bootstrap', 'Injected ' + faults.length + ' demo faults');
    return 'Injected 4 data faults:\n\n' +
           '  1. Unknown agent AG-999 ($14,500 excluded from all rollups)\n' +
           '  2. Duplicate DealId ' + sample.DealId + ' (revenue double-counted)\n' +
           '  3. CloseDate stored as text (drops out of period filters)\n' +
           '  4. Missing Amount\n\n' +
           'Health checks now report ' + status.blockers.length + ' blocker(s).\n' +
           'Try "Close the week…" — it will refuse, and say why.';
  }

  /** Removes the injected faults and re-verifies. @return {string} */
  function repairDemoFaults() {
    const sheet = Lib.mustGetSheet(Config.get('RawSalesTab', 'Raw_Sales'));
    const values = sheet.getDataRange().getValues();
    const header = values.shift();

    const seenDealIds = {};
    const kept = [];
    values.forEach(function (row) {
      const id = String(row[0]);
      if (id.indexOf('D-FAULT-') === 0) return;      // injected rows
      if (seenDealIds[Lib.normKey(id)]) return;       // the duplicate
      seenDealIds[Lib.normKey(id)] = true;
      kept.push(row);
    });

    const removed = values.length - kept.length;
    Lib.writeTable(sheet, [header].concat(kept));
    Config.flush();

    Snapshot.refreshOpenPeriod();
    Rankings.rebuild();
    const status = DataHealth.runAll();

    Lib.log('INFO', 'Bootstrap', 'Repaired demo faults: removed ' + removed + ' rows');
    return 'Removed ' + removed + ' faulty row(s), refreshed the mart and rankings.\n\n' +
           'Health checks: ' + status.blockers.length + ' blocker(s), ' +
           status.warnings.length + ' warning(s).';
  }

  /* ------------------------------------------------------------------ *
   * Data generation
   * ------------------------------------------------------------------ */

  function buildTeams() {
    return TEAMS.map(function (t) { return t.slice(); });
  }

  function buildAgents(teams) {
    const active = teams.filter(function (t) { return t[4]; });
    const rows = [];
    const rand = prng(SEED);

    for (let i = 0; i < 24; i++) {
      const id = 'AG-' + ('00' + (i + 1)).slice(-3);
      const name = FIRST[i % FIRST.length] + ' ' + LAST[(i * 7) % LAST.length];
      const team = active[i % active.length][0];
      const start = new Date(2024, Math.floor(rand() * 12), 1 + Math.floor(rand() * 27));

      // Two agents are end-dated. This is the case the old system got wrong by
      // deleting the row, which retroactively changed closed-period totals.
      const endDated = (i === 5 || i === 17);
      const end = endDated ? new Date(2026, 0, 15) : '';

      rows.push([id, name, team, start, end, true]);
    }
    return rows;
  }

  function buildDeals(agents, periods) {
    const rand = prng(SEED + 1);
    const rows = [];
    const now = new Date();
    let seq = 0;

    periods.forEach(function (period) {
      const monday = mondayOf(period);

      agents.forEach(function (agent) {
        const endDate = agent[4];
        if (endDate instanceof Date && monday > endDate) return; // left the company

        // Deliberately uneven: a few high performers, a long tail, and some
        // agents with a zero week. Flat random data makes rankings meaningless.
        const skill = 0.4 + rand() * 1.4;
        const count = Math.floor(rand() * 4 * skill);

        for (let d = 0; d < count; d++) {
          seq++;
          const dayOffset = Math.floor(rand() * 5);
          const closeDate = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + dayOffset);
          const isNew = rand() < 0.45;
          const base = isNew ? 8000 : 4500;
          const amount = Math.round((base + rand() * base * 2.2) * skill / 50) * 50;

          rows.push([
            'D-' + ('0000' + seq).slice(-5),
            agent[0],
            isNew ? 'New' : 'Renewal',
            closeDate,
            period,
            amount,
            now
          ]);
        }
      });
    });
    return rows;
  }

  function buildTargets(teams, agents, periods) {
    const rows = [];
    periods.forEach(function (period) {
      teams.forEach(function (t) {
        if (!t[4]) return;
        const headcount = agents.filter(function (a) { return a[2] === t[0]; }).length;
        rows.push([period, 'TEAM', t[0], 'Revenue', headcount * 22000]);
      });
      agents.forEach(function (a) {
        rows.push([period, 'AGENT', a[0], 'Revenue', 22000]);
      });
    });
    return rows;
  }

  function configRows(openPeriod) {
    return [
      ['Key', 'Value', 'Notes'],
      ['OpenPeriodKey', openPeriod, 'The period currently being recomputed. Advanced by the weekly close.'],
      ['RawSalesTab', 'Raw_Sales', 'Staging tab holding the deal log.'],
      ['MartSheetTab', 'Mart_AgentWeek', 'One row per agent per period. The source for all reporting.'],
      ['PrimaryRankMetric', 'Revenue', 'Metric the headline ranking sorts by.'],
      ['RequiredDealFields', 'DealId,AgentId,CloseDate,Amount', 'Enforced by the REQ_FIELDS check.'],
      ['ReconcileToleranceAbs', 0.01, 'Allowed raw-vs-mart difference before RECONCILE blocks.'],
      ['MaxImportAgeHours', 26, 'Staleness threshold for the STALE_IMPORT warning.'],
      ['VolumeDeviationThreshold', 0.4, 'Row-count anomaly sensitivity (0.4 = 40%).'],
      ['ErrorScanTabs', 'Raw_Sales,Mart_AgentWeek', 'Tabs scanned for #REF!/#N/A values.'],
      ['AlertRecipients', '', 'LEAVE BLANK IN A DEMO — adding an address sends real email.'],
      ['SummaryRecipients', '', 'LEAVE BLANK IN A DEMO — the weekly close emails this list.'],
      ['ArchiveSpreadsheetId', '', 'Optional history workbook for closed periods.'],
      ['HealthHistoryTab', '_Health History', 'Stores the row-count baseline.'],
      ['RunbookUrl', '', 'Opened from the Admin menu.']
    ];
  }

  /* ------------------------------------------------------------------ *
   * Sheet plumbing
   * ------------------------------------------------------------------ */

  function hasExistingData(ss) {
    return ['Config', 'Agents', 'Teams', 'Targets', 'Raw_Sales'].some(function (name) {
      const sheet = ss.getSheetByName(name);
      return sheet && sheet.getLastRow() > 1;
    });
  }

  function writeTab(ss, name, rows) {
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    sheet.clear();
    Lib.writeTable(sheet, rows);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold').setBackground('#efefef');
  }

  function appendMart(ss, rows) {
    if (!rows.length) return;
    const sheet = Lib.mustGetSheet(Config.get('MartSheetTab', 'Mart_AgentWeek'));
    const cols = ['PeriodKey', 'AgentId', 'AgentName', 'TeamId', 'TeamName', 'Deals',
                  'Revenue', 'NewLogos', 'Target', 'AttainmentPct', 'Status', 'ComputedAt'];
    const values = rows.map(function (r) {
      return cols.map(function (c) { return r[c] === undefined || r[c] === null ? '' : r[c]; });
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, cols.length).setValues(values);
  }

  function formatInputTabs(ss) {
    const raw = ss.getSheetByName('Raw_Sales');
    if (raw && raw.getLastRow() > 1) {
      raw.getRange(2, 4, raw.getLastRow() - 1, 1).setNumberFormat('yyyy-mm-dd');
      raw.getRange(2, 6, raw.getLastRow() - 1, 1).setNumberFormat('$#,##0');
      raw.getRange(2, 7, raw.getLastRow() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    }
    const targets = ss.getSheetByName('Targets');
    if (targets && targets.getLastRow() > 1) {
      targets.getRange(2, 5, targets.getLastRow() - 1, 1).setNumberFormat('$#,##0');
    }
    const agents = ss.getSheetByName('Agents');
    if (agents && agents.getLastRow() > 1) {
      agents.getRange(2, 4, agents.getLastRow() - 1, 2).setNumberFormat('yyyy-mm-dd');
    }
    ['Config', 'Teams', 'Agents', 'Targets', 'Raw_Sales'].forEach(function (n) {
      const s = ss.getSheetByName(n);
      if (s) s.autoResizeColumns(1, s.getLastColumn());
    });
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  /** The last n ISO week keys, oldest first, ending with the current week. */
  function recentPeriods(n) {
    const out = [];
    const today = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i * 7);
      out.push(Lib.isoWeek(d));
    }
    return out;
  }

  /** Monday of a "yyyy-Www" period key. */
  function mondayOf(periodKey) {
    const m = String(periodKey).match(/^(\d{4})-W(\d{1,2})$/);
    if (!m) throw new Error('Bad period key: ' + periodKey);
    const year = Number(m[1]);
    const week = Number(m[2]);
    const jan4 = new Date(year, 0, 4);
    const dayNum = jan4.getDay() || 7;
    const week1Monday = new Date(year, 0, 4 - dayNum + 1);
    return new Date(week1Monday.getFullYear(), week1Monday.getMonth(),
                    week1Monday.getDate() + (week - 1) * 7);
  }

  /** Mulberry32 — small, fast, deterministic. Demos must be reproducible. */
  function prng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  return {
    bootstrapDemo: bootstrapDemo,
    injectDemoFaults: injectDemoFaults,
    repairDemoFaults: repairDemoFaults,
    // Exposed for Tests.gs. The period arithmetic is the part worth testing:
    // if mondayOf and Lib.isoWeek ever disagree, generated deals land in the
    // wrong week and every downstream total is quietly wrong.
    mondayOf: mondayOf,
    recentPeriods: recentPeriods,
    buildTeams: buildTeams,
    buildAgents: buildAgents,
    buildDeals: buildDeals
  };
})();

/** Editor-callable wrappers. */
function bootstrapDemo(force) { return Bootstrap.bootstrapDemo(force); }
function injectDemoFaults() { return Bootstrap.injectDemoFaults(); }
function repairDemoFaults() { return Bootstrap.repairDemoFaults(); }
