/**
 * Triggers.gs — declarative trigger installation.
 *
 * WHY THIS EXISTS
 * ---------------
 * In the inherited system the schedule was undocumented. Triggers had been
 * created by hand over three years; two were duplicates firing the same job
 * twice, one pointed at a function that had been renamed (and had therefore
 * been failing nightly for eight months without anyone noticing), and all of
 * them were owned by a person, not the team.
 *
 * That last point is the one that bites: Apps Script triggers run as the user
 * who created them. When that person's account is suspended, every scheduled
 * job stops — quietly. If the system is business-critical, triggers should be
 * owned by a shared service account, and that ownership should be written down.
 *
 * Here the schedule is code. `installTriggers()` is idempotent: it removes what
 * this project installed and recreates it from the declaration below, so the
 * running schedule always matches what you can read.
 */

const Triggers = (function () {

  /**
   * The complete schedule. If it is not in this list, it should not be running.
   */
  const SCHEDULE = [
    {
      handler: 'trigger_dailyRefresh',
      description: 'Refresh open period + rankings, weekdays early morning',
      build: function () {
        return ScriptApp.newTrigger('trigger_dailyRefresh')
          .timeBased().atHour(5).everyDays(1);
      }
    },
    {
      handler: 'trigger_weeklyClose',
      description: 'Close the week and email the summary, Monday morning',
      build: function () {
        return ScriptApp.newTrigger('trigger_weeklyClose')
          .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7);
      }
    },
    {
      handler: 'trigger_nightlyAudit',
      description: 'Re-run the structural audit so drift is visible',
      build: function () {
        return ScriptApp.newTrigger('trigger_nightlyAudit')
          .timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(23);
      }
    },
    {
      handler: 'runDataHealth',
      description: 'Data health checks twice daily',
      build: function () {
        return ScriptApp.newTrigger('runDataHealth')
          .timeBased().everyHours(12);
      }
    }
  ];

  /** Handlers this project owns; anything else is left alone. */
  const OWNED = SCHEDULE.map(function (s) { return s.handler; });

  /**
   * Removes this project's triggers and reinstalls them from SCHEDULE.
   * Safe to run repeatedly.
   *
   * @return {!Array<string>} human-readable log of what happened.
   */
  function install() {
    const log = [];
    const existing = ScriptApp.getProjectTriggers();

    existing.forEach(function (t) {
      const handler = t.getHandlerFunction();
      if (OWNED.indexOf(handler) !== -1) {
        ScriptApp.deleteTrigger(t);
        log.push('Removed existing trigger: ' + handler);
      } else {
        log.push('Left untouched (not owned by this project): ' + handler);
      }
    });

    SCHEDULE.forEach(function (s) {
      s.build().create();
      log.push('Installed: ' + s.handler + ' — ' + s.description);
    });

    Lib.log('INFO', 'Triggers.install', log.join(' | '));
    return log;
  }

  /** Removes only the triggers declared in SCHEDULE. */
  function uninstall() {
    let removed = 0;
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (OWNED.indexOf(t.getHandlerFunction()) !== -1) {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    });
    Lib.log('INFO', 'Triggers.uninstall', 'Removed ' + removed + ' trigger(s).');
    return removed;
  }

  /**
   * Reports the live schedule against the declared one, so drift is visible.
   * @return {!Array<!Array>} rows for display.
   */
  function status() {
    const live = {};
    ScriptApp.getProjectTriggers().forEach(function (t) {
      const h = t.getHandlerFunction();
      live[h] = (live[h] || 0) + 1;
    });

    const rows = [['Handler', 'Declared', 'Live instances', 'State', 'Description']];

    SCHEDULE.forEach(function (s) {
      const count = live[s.handler] || 0;
      delete live[s.handler];
      rows.push([
        s.handler, 'Yes', count,
        count === 0 ? 'MISSING' : (count > 1 ? 'DUPLICATED' : 'OK'),
        s.description
      ]);
    });

    Object.keys(live).forEach(function (h) {
      rows.push([h, 'No', live[h], 'UNDECLARED',
        'Running but not in SCHEDULE — confirm it is intentional, then declare it here.']);
    });

    return rows;
  }

  return { install: install, uninstall: uninstall, status: status, SCHEDULE: SCHEDULE };
})();

/** Menu-callable wrappers. */
function installTriggers() { return Triggers.install(); }
function uninstallTriggers() { return Triggers.uninstall(); }
