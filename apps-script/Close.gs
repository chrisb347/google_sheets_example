/**
 * Close.gs — the weekly close, as one operation.
 *
 * WHAT THIS REPLACED
 * ------------------
 * An 11-step manual runbook that lived in the Data & Analytics Manager's head
 * and took most of a Monday:
 *
 *    1. Open each of the 4 regional workbooks and confirm the imports "look right"
 *    2. Copy last week's Rankings tab and paste-special as values into Archive
 *    3. Update the week label in D1 on six tabs
 *    4. Drag the formulas down on Agent Summary to cover new rows
 *    5. Refresh the pivot ranges
 *    6. Check the totals against the CRM export by eye
 *    7. Fix any #N/A by hand
 *    8. Update targets for anyone who changed teams
 *    9. Copy the summary block into the email
 *   10. Re-hide the working tabs
 *   11. Re-protect the ranges someone unprotected last week
 *
 * Every step was order-dependent, and a deviation corrupted the week silently.
 * Steps 4 and 7 in particular were where wrong numbers entered the system:
 * dragging formulas one row short under-counted, and hand-fixing #N/A meant
 * overwriting a formula with a typed value that nobody could later audit.
 *
 * WHAT IT IS NOW
 * --------------
 * One operation, in a fixed order, that refuses to proceed on bad data and
 * reports what it did. Idempotent — running it twice produces the same result,
 * which matters because someone will run it twice.
 */

const Close = (function () {

  /**
   * Refreshes the open period without closing it. Safe to run any number of
   * times; this is what the daily trigger calls.
   *
   * @return {!Object} summary
   */
  function refresh() {
    const started = Date.now();
    const steps = [];

    const health = DataHealth.runAll();
    steps.push('Health: ' + health.blockers.length + ' blocker(s), ' + health.warnings.length + ' warning(s)');
    if (!health.ok) {
      const message = 'Refresh halted — blocking data issues:\n' +
        health.blockers.map(function (b) { return '  • ' + b.name + ': ' + b.detail; }).join('\n');
      Lib.log('ERROR', 'Close.refresh', message);
      return { ok: false, steps: steps, message: message };
    }

    const snap = Snapshot.refreshOpenPeriod();
    steps.push('Mart: ' + snap.agentRows + ' agent rows for ' + snap.periodKey);

    const ranks = Rankings.rebuild(snap.periodKey);
    steps.push('Rankings: ' + ranks.agents + ' agents ranked, movement vs ' + (ranks.priorPeriod || 'n/a'));

    steps.push('Elapsed: ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
    Lib.log('INFO', 'Close.refresh', steps.join(' | '));

    return { ok: true, steps: steps, period: snap.periodKey };
  }

  /**
   * The full weekly close: refresh, freeze the period, advance to the next one,
   * and send the summary. This is the one that is not idempotent by design —
   * it advances state — so it asks for confirmation when run from the menu.
   *
   * @return {!Object} summary
   */
  function weeklyClose() {
    const started = Date.now();
    const steps = [];

    const refreshed = refresh();
    if (!refreshed.ok) return refreshed;
    Array.prototype.push.apply(steps, refreshed.steps);

    const closedPeriod = Config.get('OpenPeriodKey');
    const closed = Snapshot.closePeriod(closedPeriod);
    steps.push('Closed ' + closed.periodKey + ' (' + closed.rows + ' rows frozen as values)');

    Config.flush();
    steps.push('Open period is now ' + Config.get('OpenPeriodKey'));

    sendSummary(closedPeriod, steps);
    steps.push('Elapsed: ' + ((Date.now() - started) / 1000).toFixed(1) + 's');

    Lib.log('INFO', 'Close.weeklyClose', steps.join(' | '));
    return { ok: true, steps: steps, period: closedPeriod };
  }

  /**
   * Emails the closed-week summary. Replaces step 9 of the old runbook —
   * copying a block of cells into an email by hand, which meant the emailed
   * figure and the workbook figure could and did diverge.
   */
  function sendSummary(periodKey, steps) {
    const recipients = Config.getList('SummaryRecipients', '');
    if (!recipients.length) {
      Lib.log('WARN', 'Close.sendSummary', 'No SummaryRecipients configured; skipping email.');
      return;
    }

    const mart = Lib.readObjects(Lib.mustGetSheet(Config.get('MartSheetTab', 'Mart_AgentWeek')))
      .filter(function (r) { return Lib.normKey(r.PeriodKey) === Lib.normKey(periodKey); });

    const totalRevenue = mart.reduce(function (a, r) { return a + (Number(r.Revenue) || 0); }, 0);
    const totalDeals = mart.reduce(function (a, r) { return a + (Number(r.Deals) || 0); }, 0);

    const byTeam = {};
    mart.forEach(function (r) {
      const key = r.TeamName || r.TeamId;
      byTeam[key] = (byTeam[key] || 0) + (Number(r.Revenue) || 0);
    });

    const top = mart.slice()
      .sort(function (a, b) { return (Number(b.Revenue) || 0) - (Number(a.Revenue) || 0); })
      .slice(0, 5);

    const body = [
      'Week ' + periodKey + ' is closed.',
      '',
      'Company: ' + money(totalRevenue) + ' across ' + totalDeals + ' deals (' + mart.length + ' agents).',
      '',
      'By team:',
    ].concat(
      Object.keys(byTeam).sort(function (a, b) { return byTeam[b] - byTeam[a]; })
        .map(function (t) { return '  ' + t + ': ' + money(byTeam[t]); })
    ).concat([
      '',
      'Top 5 agents:',
    ]).concat(
      top.map(function (r, i) {
        return '  ' + (i + 1) + '. ' + r.AgentName + ' (' + r.TeamName + ') — ' + money(r.Revenue);
      })
    ).concat([
      '',
      'Run log:',
    ]).concat(
      steps.map(function (s) { return '  • ' + s; })
    ).join('\n');

    Lib.alert('Sales week closed: ' + periodKey, body, recipients);
  }

  function money(n) {
    return (Number(n) || 0).toLocaleString('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0
    });
  }

  return { refresh: refresh, weeklyClose: weeklyClose };
})();

/* -------------------------------------------------------------------- *
 * Trigger entry points. Kept as thin named globals because triggers bind
 * to a function name — renaming one silently orphans its trigger.
 * -------------------------------------------------------------------- */

function trigger_dailyRefresh() {
  Close.refresh();
}

function trigger_weeklyClose() {
  const result = Close.weeklyClose();
  if (!result.ok) {
    Lib.alert('[BLOCKED] Weekly close did not run',
      result.message, Config.getList('AlertRecipients', ''));
  }
}

function trigger_nightlyAudit() {
  Audit.auditWorkbook();
}
