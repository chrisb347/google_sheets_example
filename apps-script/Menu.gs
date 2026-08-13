/**
 * Menu.gs — the operator interface.
 *
 * The internal team should never have to open the script editor to run the
 * system. Anything that involves telling a colleague "open Extensions → Apps
 * Script → select the function → press run" is a process that will eventually
 * be done wrong, at speed, on a Monday.
 *
 * Destructive or state-advancing actions confirm first and say exactly what
 * they are about to do.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Sales Ops')
    .addItem('Refresh current period', 'menuRefresh')
    .addItem('Rebuild rankings only', 'menuRebuildRankings')
    .addSeparator()
    .addItem('Run data health checks', 'menuDataHealth')
    .addItem('Run system audit', 'menuAudit')
    .addSeparator()
    .addItem('Close the week…', 'menuWeeklyClose')
    .addItem('Reopen a closed period…', 'menuReopenPeriod')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Admin')
      .addItem('Show trigger status', 'menuTriggerStatus')
      .addItem('Install/repair triggers', 'menuInstallTriggers')
      .addItem('Open the runbook', 'menuRunbook'))
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Demo')
      .addItem('Build demo system', 'menuBootstrap')
      .addItem('Inject data faults', 'menuInjectFaults')
      .addItem('Repair data faults', 'menuRepairFaults'))
    .addToUi();
}

/* -------------------------------------------------------------------- *
 * Demo menu — remove this submenu before pointing the code at a real
 * workbook. Bootstrap refuses to overwrite populated tabs, but the menu
 * item itself is an invitation nobody needs in production.
 * -------------------------------------------------------------------- */

function menuBootstrap() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    'Build the demo system?',
    'This creates the Config, Teams, Agents, Targets, Raw_Sales and ' +
    'Mart_AgentWeek tabs and fills them with generated sample data — ' +
    '24 agents across 5 active teams, 6 weeks of deals.\n\n' +
    'It will refuse to run if those tabs already contain data.\n\n' +
    'Takes about 30 seconds.',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  run_('Build demo system', function () { return Bootstrap.bootstrapDemo(); });
}

function menuInjectFaults() {
  run_('Inject data faults', function () { return Bootstrap.injectDemoFaults(); });
}

function menuRepairFaults() {
  run_('Repair data faults', function () { return Bootstrap.repairDemoFaults(); });
}

function menuRefresh() {
  run_('Refresh current period', function () {
    const result = Close.refresh();
    return result.ok
      ? result.steps.join('\n')
      : 'Refresh did not run.\n\n' + result.message;
  });
}

function menuRebuildRankings() {
  run_('Rebuild rankings', function () {
    const r = Rankings.rebuild();
    return 'Ranked ' + r.agents + ' agents for ' + r.period +
           '\nMovement calculated vs ' + (r.priorPeriod || 'no prior period');
  });
}

function menuDataHealth() {
  run_('Data health', function () {
    const status = DataHealth.runAll();
    const lines = status.results.map(function (r) {
      return (r.pass ? '  PASS  ' : (r.severity === 'BLOCKER' ? '  FAIL* ' : '  warn  ')) + r.name;
    });
    return lines.join('\n') +
      '\n\n' + status.blockers.length + ' blocker(s), ' + status.warnings.length + ' warning(s).' +
      '\nDetail is on the "' + DataHealth.STATUS_SHEET + '" tab.';
  });
}

function menuAudit() {
  run_('System audit', function () {
    const result = Audit.auditWorkbook();
    const high = result.findings.filter(function (f) { return f.severity === 'HIGH'; }).length;
    return 'Scanned ' + result.summaries.length + ' tabs.\n' +
           result.findings.length + ' finding(s), ' + high + ' high severity.\n\n' +
           'See "' + Audit.FINDINGS_SHEET + '" and "' + Audit.SUMMARY_SHEET + '".';
  });
}

function menuWeeklyClose() {
  const ui = SpreadsheetApp.getUi();
  const period = Config.get('OpenPeriodKey');

  const answer = ui.alert(
    'Close ' + period + '?',
    'This will:\n' +
    '  • run the data health checks (and stop if any blocker fails)\n' +
    '  • recompute ' + period + ' and freeze it as values\n' +
    '  • advance the open period to the following week\n' +
    '  • email the summary to the configured recipients\n\n' +
    'Closed periods stop recalculating. They can be reopened from this menu ' +
    'if a late adjustment comes in.\n\nProceed?',
    ui.ButtonSet.YES_NO);

  if (answer !== ui.Button.YES) return;

  run_('Weekly close', function () {
    const result = Close.weeklyClose();
    return result.ok
      ? result.steps.join('\n')
      : 'Close did not run.\n\n' + result.message;
  });
}

function menuReopenPeriod() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Reopen a closed period',
    'Enter the period key to reopen (e.g. 2026-W07).\n\n' +
    'Reopening means published figures for that period can change. ' +
    'The action is logged.',
    ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK) return;
  const key = response.getResponseText().trim();
  if (!key) return;

  run_('Reopen period', function () {
    const r = Snapshot.reopenPeriod(key);
    return 'Reopened ' + r.periodKey + ' (' + r.rows + ' rows).\n' +
           'Run "Refresh current period" to recompute it.';
  });
}

function menuTriggerStatus() {
  run_('Trigger status', function () {
    const rows = Triggers.status();
    return rows.slice(1).map(function (r) {
      return r[3] + '  ' + r[0] + '  (live: ' + r[2] + ')';
    }).join('\n') + '\n\nTriggers run as the account that created them.';
  });
}

function menuInstallTriggers() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    'Install/repair triggers',
    'This removes and recreates the four triggers declared in Triggers.gs. ' +
    'Triggers created by other people or other projects are left alone.\n\n' +
    'Note: the recreated triggers will run as YOUR account. For a business-' +
    'critical system, run this from the shared service account instead.\n\nProceed?',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  run_('Install triggers', function () {
    return Triggers.install().join('\n');
  });
}

function menuRunbook() {
  const url = Config.get('RunbookUrl', '');
  const ui = SpreadsheetApp.getUi();
  if (!url) {
    ui.alert('No runbook URL set', 'Add a "RunbookUrl" row to the Config tab.', ui.ButtonSet.OK);
    return;
  }
  const html = HtmlService.createHtmlOutput(
    '<p style="font-family:Arial,sans-serif">' +
    '<a href="' + url + '" target="_blank" rel="noopener">Open the runbook</a></p>')
    .setWidth(320).setHeight(90);
  ui.showModalDialog(html, 'Runbook');
}

/**
 * Shared wrapper: runs the action, shows the result, and turns an exception
 * into a readable message rather than a raw stack trace in a toast.
 *
 * @param {string} title
 * @param {!Function} fn Returns the message to display.
 */
function run_(title, fn) {
  const ui = SpreadsheetApp.getUi();
  SpreadsheetApp.getActiveSpreadsheet().toast('Running…', title, -1);
  try {
    const message = fn();
    SpreadsheetApp.getActiveSpreadsheet().toast('Done', title, 5);
    ui.alert(title, message, ui.ButtonSet.OK);
  } catch (err) {
    SpreadsheetApp.getActiveSpreadsheet().toast('Failed', title, 5);
    Lib.log('ERROR', 'Menu.' + title, err && err.stack ? err.stack : String(err));
    ui.alert(title + ' — failed',
      (err && err.message ? err.message : String(err)) +
      '\n\nThis has been written to the _Log tab.',
      ui.ButtonSet.OK);
  }
}
