/**
 * Config.gs — single source of truth for everything that changes over time.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * In the inherited system, the agent roster appeared as a hardcoded list in 14
 * places: three QUERY strings, four COUNTIFS criteria ranges, two dropdown
 * validation lists, the ranking tab, and four script constants. Onboarding one
 * agent meant 14 coordinated edits. Missing one produced an under-count, not an
 * error — so nobody found out until a rep queried their commission.
 *
 * Now: agents, teams, targets, periods and settings live on tabs. Formulas read
 * those tabs through array formulas; scripts read them through this module.
 * Adding an agent is one row and nothing else.
 *
 * Expected tabs
 * -------------
 * Config    | Key | Value | Notes                (scalar settings)
 * Agents    | AgentId | AgentName | TeamId | StartDate | EndDate | Active
 * Teams     | TeamId | TeamName | RegionId | ManagerEmail | Active
 * Targets   | PeriodKey | ScopeType | ScopeId | Metric | TargetValue
 */

const Config = (function () {

  const SHEETS = {
    config: 'Config',
    agents: 'Agents',
    teams: 'Teams',
    targets: 'Targets'
  };

  // Cached per execution. Apps Script executions are short-lived, so this is
  // simply avoiding re-reading the same tab five times in one run.
  let _settings = null;
  let _agents = null;
  let _teams = null;

  /** @return {!Object<string,string>} all Config key/value pairs. */
  function settings() {
    if (_settings) return _settings;
    const rows = Lib.readObjects(Lib.mustGetSheet(SHEETS.config));
    _settings = {};
    rows.forEach(function (r) {
      if (r.Key) _settings[String(r.Key).trim()] = r.Value;
    });
    return _settings;
  }

  /**
   * Reads a required setting. Throws with a useful message rather than
   * returning undefined and failing 30 lines later.
   *
   * @param {string} key
   * @param {*=} fallback If omitted, the key is required.
   * @return {*}
   */
  function get(key, fallback) {
    const all = settings();
    if (Object.prototype.hasOwnProperty.call(all, key) && all[key] !== '') {
      return all[key];
    }
    if (arguments.length >= 2) return fallback;
    throw new Error('Missing required setting "' + key + '" on the Config tab.');
  }

  /** @return {number} */
  function getNumber(key, fallback) {
    const raw = get(key, fallback);
    const num = Number(raw);
    if (isNaN(num)) throw new Error('Setting "' + key + '" must be a number, got: ' + raw);
    return num;
  }

  /** @return {boolean} */
  function getBool(key, fallback) {
    const raw = String(get(key, fallback)).trim().toLowerCase();
    return raw === 'true' || raw === 'yes' || raw === '1';
  }

  /** @return {!Array<string>} comma-separated setting as a trimmed list. */
  function getList(key, fallback) {
    const raw = String(get(key, fallback === undefined ? '' : fallback));
    return raw.split(',').map(function (s) { return s.trim(); }).filter(String);
  }

  /**
   * Active agents as of a date. Effective-dated so historical reporting stays
   * correct after someone leaves — the old system deleted departed agents,
   * which silently changed last quarter's team totals.
   *
   * @param {Date=} asOf Defaults to now.
   * @return {!Array<!Object>}
   */
  function activeAgents(asOf) {
    if (!_agents) _agents = Lib.readObjects(Lib.mustGetSheet(SHEETS.agents));
    const when = asOf || new Date();
    return _agents.filter(function (a) {
      if (String(a.Active).toLowerCase() === 'false') return false;
      const start = a.StartDate instanceof Date ? a.StartDate : null;
      const end = a.EndDate instanceof Date ? a.EndDate : null;
      if (start && when < start) return false;
      if (end && when > end) return false;
      return true;
    });
  }

  /** @return {!Object<string,!Object>} AgentId -> agent record (all agents). */
  function agentIndex() {
    if (!_agents) _agents = Lib.readObjects(Lib.mustGetSheet(SHEETS.agents));
    const index = {};
    _agents.forEach(function (a) { index[Lib.normKey(a.AgentId)] = a; });
    return index;
  }

  /** @return {!Array<!Object>} */
  function activeTeams() {
    if (!_teams) _teams = Lib.readObjects(Lib.mustGetSheet(SHEETS.teams));
    return _teams.filter(function (t) {
      return String(t.Active).toLowerCase() !== 'false';
    });
  }

  /** @return {!Object<string,!Object>} TeamId -> team record. */
  function teamIndex() {
    if (!_teams) _teams = Lib.readObjects(Lib.mustGetSheet(SHEETS.teams));
    const index = {};
    _teams.forEach(function (t) { index[Lib.normKey(t.TeamId)] = t; });
    return index;
  }

  /**
   * Targets keyed by period + scope + metric, e.g. "2026-W07|TEAM|T-NORTH|Revenue".
   * @return {!Object<string,number>}
   */
  function targetIndex() {
    const rows = Lib.readObjects(Lib.mustGetSheet(SHEETS.targets));
    const index = {};
    rows.forEach(function (r) {
      const key = [r.PeriodKey, r.ScopeType, r.ScopeId, r.Metric]
        .map(Lib.normKey).join('|');
      index[key] = Number(r.TargetValue) || 0;
    });
    return index;
  }

  /** Clears the per-execution cache. Only needed in long-running batch jobs. */
  function flush() {
    _settings = null;
    _agents = null;
    _teams = null;
  }

  return {
    SHEETS: SHEETS,
    settings: settings,
    get: get,
    getNumber: getNumber,
    getBool: getBool,
    getList: getList,
    activeAgents: activeAgents,
    agentIndex: agentIndex,
    activeTeams: activeTeams,
    teamIndex: teamIndex,
    targetIndex: targetIndex,
    flush: flush
  };
})();
