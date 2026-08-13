/**
 * Rankings.gs — agent and team rankings, computed in script from the mart.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * Rankings were previously a grid of per-row formulas:
 *
 *   =RANK(G2, $G$2:$G$500) + COUNTIFS($G$2:$G$500,">"&G2, $D$2:$D$500,D2)
 *   =IFERROR(VLOOKUP(A2, 'Last Week'!$A:$H, 8, FALSE), "")   ← movement
 *
 * Three problems, all of which cost real money at some point:
 *
 *   1. O(n²). Each RANK scans the full column; 400 agents meant 160,000 cell
 *      comparisons per metric, recalculated on every workbook edit.
 *   2. The ranges were hardcoded to row 500. Agent 501 ranked as unranked, and
 *      nothing said so.
 *   3. Ties were handled inconsistently between tabs — the company tab used
 *      RANK (competition ranking) and the team tab used a COUNTIFS variant
 *      (dense ranking), so the same two tied reps had different ranks depending
 *      on which tab you opened. That one surfaced in a commission dispute.
 *
 * Now: one pass, one sort, one documented tie rule, no row limit.
 *
 * Tie rule: standard competition ranking. Two agents tied for 2nd are both 2nd,
 * and the next agent is 4th. Stated once, applied everywhere.
 */

const Rankings = (function () {

  const OUTPUT_TAB = 'Rankings';

  const METRICS = [
    { field: 'Revenue',  label: 'Revenue',   format: '$#,##0' },
    { field: 'Deals',    label: 'Deals',     format: '#,##0' },
    { field: 'NewLogos', label: 'New logos', format: '#,##0' }
  ];

  /**
   * Rebuilds the Rankings tab for a period, including movement vs the prior
   * period.
   *
   * @param {string=} periodKey Defaults to the open period.
   * @return {!Object}
   */
  function rebuild(periodKey) {
    return Lib.withLock('Rankings.rebuild', function () {
      const period = periodKey || Config.get('OpenPeriodKey');
      const mart = Lib.readObjects(Lib.mustGetSheet(Config.get('MartSheetTab', 'Mart_AgentWeek')));

      const current = mart.filter(function (r) { return Lib.normKey(r.PeriodKey) === Lib.normKey(period); });
      if (!current.length) {
        throw new Error('No mart rows for period "' + period + '". Run "Refresh current period" first.');
      }

      const priorKey = previousPeriodKey(mart, period);
      const prior = priorKey
        ? mart.filter(function (r) { return Lib.normKey(r.PeriodKey) === Lib.normKey(priorKey); })
        : [];

      const primary = Config.get('PrimaryRankMetric', 'Revenue');
      const currentRanked = rankAll(current);
      const priorRanked = rankAll(prior);

      const priorCompanyRank = {};
      priorRanked.forEach(function (r) {
        priorCompanyRank[Lib.normKey(r.AgentId)] = r.ranks[primary].company;
      });

      const rows = buildAgentTable(currentRanked, priorCompanyRank, primary, period, priorKey);
      const teamRows = buildTeamTable(current, period);

      write(rows, teamRows, period, priorKey);
      Lib.log('INFO', 'Rankings', 'Rebuilt ' + period + ' (' + current.length + ' agents, ' +
        teamRows.length + ' teams), movement vs ' + (priorKey || 'n/a'));

      return { period: period, agents: current.length, priorPeriod: priorKey };
    });
  }

  /* ------------------------------------------------------------------ *
   * Ranking
   * ------------------------------------------------------------------ */

  /**
   * Attaches company-wide and within-team ranks for every metric.
   * @param {!Array<!Object>} rows Mart rows for a single period.
   * @return {!Array<!Object>}
   */
  function rankAll(rows) {
    const enriched = rows.map(function (r) {
      return {
        AgentId: r.AgentId, AgentName: r.AgentName,
        TeamId: r.TeamId, TeamName: r.TeamName,
        Revenue: Number(r.Revenue) || 0,
        Deals: Number(r.Deals) || 0,
        NewLogos: Number(r.NewLogos) || 0,
        Target: Number(r.Target) || 0,
        AttainmentPct: r.AttainmentPct === '' ? null : Number(r.AttainmentPct),
        ranks: {}
      };
    });

    METRICS.forEach(function (m) {
      assignRanks(enriched, m.field, function (row, rank) {
        row.ranks[m.field] = row.ranks[m.field] || {};
        row.ranks[m.field].company = rank;
      });

      groupBy(enriched, 'TeamId').forEach(function (group) {
        assignRanks(group, m.field, function (row, rank) {
          row.ranks[m.field].team = rank;
        });
      });
    });

    return enriched;
  }

  /**
   * Standard competition ranking (1, 2, 2, 4) on a descending numeric field.
   * @param {!Array<!Object>} rows
   * @param {string} field
   * @param {!Function} assign (row, rank) => void
   */
  function assignRanks(rows, field, assign) {
    const sorted = rows.slice().sort(function (a, b) {
      const d = (b[field] || 0) - (a[field] || 0);
      // Deterministic tiebreak so the display order is stable between runs even
      // though the *rank* is shared.
      return d !== 0 ? d : String(a.AgentId).localeCompare(String(b.AgentId));
    });

    let lastValue = null;
    let lastRank = 0;
    sorted.forEach(function (row, i) {
      const value = row[field] || 0;
      const rank = (lastValue !== null && value === lastValue) ? lastRank : i + 1;
      assign(row, rank);
      lastValue = value;
      lastRank = rank;
    });
  }

  /* ------------------------------------------------------------------ *
   * Table construction
   * ------------------------------------------------------------------ */

  function buildAgentTable(ranked, priorCompanyRank, primary, period, priorKey) {
    const sorted = ranked.slice().sort(function (a, b) {
      return a.ranks[primary].company - b.ranks[primary].company ||
             String(a.AgentName).localeCompare(String(b.AgentName));
    });

    return sorted.map(function (r) {
      const prev = priorCompanyRank[Lib.normKey(r.AgentId)];
      let movement = '';
      let movementLabel = 'New';
      if (prev !== undefined) {
        movement = prev - r.ranks[primary].company; // positive = moved up
        movementLabel = movement === 0 ? '—' : (movement > 0 ? '▲ ' + movement : '▼ ' + Math.abs(movement));
      }

      return {
        rank: r.ranks[primary].company,
        teamRank: r.ranks[primary].team,
        agentId: r.AgentId,
        agentName: r.AgentName,
        teamName: r.TeamName,
        revenue: r.Revenue,
        deals: r.Deals,
        newLogos: r.NewLogos,
        attainment: r.AttainmentPct === null ? '' : r.AttainmentPct,
        movement: movementLabel,
        movementValue: movement
      };
    });
  }

  function buildTeamTable(currentRows, period) {
    const byTeam = {};
    currentRows.forEach(function (r) {
      const key = Lib.normKey(r.TeamId);
      if (!byTeam[key]) {
        byTeam[key] = {
          TeamId: r.TeamId, TeamName: r.TeamName,
          Revenue: 0, Deals: 0, NewLogos: 0, Headcount: 0, Target: 0
        };
      }
      const t = byTeam[key];
      t.Revenue += Number(r.Revenue) || 0;
      t.Deals += Number(r.Deals) || 0;
      t.NewLogos += Number(r.NewLogos) || 0;
      t.Headcount += 1;
    });

    const targets = Config.targetIndex();
    const teams = Object.keys(byTeam).map(function (k) {
      const t = byTeam[k];
      const targetKey = [period, 'TEAM', t.TeamId, 'Revenue'].map(Lib.normKey).join('|');
      t.Target = targets[targetKey] || 0;
      t.AttainmentPct = t.Target > 0 ? t.Revenue / t.Target : '';
      t.RevenuePerHead = t.Headcount > 0 ? t.Revenue / t.Headcount : 0;
      return t;
    });

    assignRanks(teams, 'Revenue', function (row, rank) { row.Rank = rank; });
    return teams.sort(function (a, b) { return a.Rank - b.Rank; });
  }

  /* ------------------------------------------------------------------ *
   * Output
   * ------------------------------------------------------------------ */

  function write(agentRows, teamRows, period, priorKey) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(OUTPUT_TAB) || ss.insertSheet(OUTPUT_TAB);

    const table = [];
    table.push(['Agent rankings — ' + period,
                priorKey ? 'movement vs ' + priorKey : 'no prior period', '', '', '', '', '', '', '', '']);
    table.push(['Rank', 'Move', 'Team rank', 'Agent', 'Team', 'Revenue', 'Deals', 'New logos', 'Attainment', 'Agent ID']);

    agentRows.forEach(function (r) {
      table.push([r.rank, r.movement, r.teamRank, r.agentName, r.teamName,
                  r.revenue, r.deals, r.newLogos, r.attainment, r.agentId]);
    });

    const teamStart = table.length + 2;
    table.push([]);
    table.push(['Team rankings — ' + period, '', '', '', '', '', '', '', '', '']);
    table.push(['Rank', 'Team', 'Revenue', 'Deals', 'New logos', 'Headcount', 'Revenue / head', 'Target', 'Attainment', '']);
    teamRows.forEach(function (t) {
      table.push([t.Rank, t.TeamName, t.Revenue, t.Deals, t.NewLogos,
                  t.Headcount, t.RevenuePerHead, t.Target, t.AttainmentPct, '']);
    });

    Lib.writeTable(sheet, table);

    // Formatting
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold').setFontSize(12);
    sheet.getRange(2, 1, 1, 10).setFontWeight('bold').setBackground('#efefef');
    sheet.getRange(teamStart + 1, 1, 1, 2).setFontWeight('bold').setFontSize(12);
    sheet.getRange(teamStart + 2, 1, 1, 10).setFontWeight('bold').setBackground('#efefef');
    sheet.setFrozenRows(2);

    if (agentRows.length) {
      sheet.getRange(3, 6, agentRows.length, 1).setNumberFormat('$#,##0');
      sheet.getRange(3, 9, agentRows.length, 1).setNumberFormat('0.0%');
      sheet.getRange(3, 2, agentRows.length, 1)
           .setFontColors(agentRows.map(function (r) {
             if (r.movementValue === '' || r.movementValue === 0) return ['#666666'];
             return [r.movementValue > 0 ? '#137333' : '#a50e0e'];
           }));
    }
    if (teamRows.length) {
      sheet.getRange(teamStart + 3, 3, teamRows.length, 1).setNumberFormat('$#,##0');
      sheet.getRange(teamStart + 3, 7, teamRows.length, 2).setNumberFormat('$#,##0');
      sheet.getRange(teamStart + 3, 9, teamRows.length, 1).setNumberFormat('0.0%');
    }
    sheet.autoResizeColumns(1, 10);
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  /** The most recent period in the mart that sorts before `period`. */
  function previousPeriodKey(mart, period) {
    const keys = {};
    mart.forEach(function (r) { if (r.PeriodKey) keys[String(r.PeriodKey)] = true; });
    const sorted = Object.keys(keys).sort();
    const index = sorted.indexOf(String(period));
    return index > 0 ? sorted[index - 1] : null;
  }

  function groupBy(rows, field) {
    const groups = {};
    rows.forEach(function (r) {
      const key = Lib.normKey(r[field]);
      (groups[key] = groups[key] || []).push(r);
    });
    return Object.keys(groups).map(function (k) { return groups[k]; });
  }

  return {
    rebuild: rebuild,
    rankAll: rankAll,
    assignRanks: assignRanks,
    OUTPUT_TAB: OUTPUT_TAB
  };
})();

/** Menu- and trigger-callable wrapper. */
function rebuildRankings() { return Rankings.rebuild(); }
