/**
 * Tests.gs — unit tests for the logic that is expensive to get wrong.
 *
 * Apps Script has no test runner, which is the usual reason inherited script
 * projects have no tests at all. This is a ~40-line runner; that is enough.
 *
 * What is tested here is deliberately narrow: the pure logic where a subtle
 * error produces a plausible wrong number rather than a crash. Tie handling in
 * rankings is the canonical example — it caused a real commission dispute in
 * the inherited system and nobody spotted it for months, because the output
 * looked entirely reasonable.
 *
 * Run: Sales Ops menu is not wired to this deliberately — run `runTests()`
 * from the editor, or call it from a deployment check.
 */

function runTests() {
  const results = [];

  suite_(results, 'Rankings.assignRanks', function (t) {

    t('assigns 1..n with no ties', function () {
      const rows = [{ id: 'a', v: 10 }, { id: 'b', v: 30 }, { id: 'c', v: 20 }];
      const ranks = rank_(rows);
      assertEqual_(ranks.b, 1, 'highest value ranks 1');
      assertEqual_(ranks.c, 2, 'middle ranks 2');
      assertEqual_(ranks.a, 3, 'lowest ranks 3');
    });

    t('uses competition ranking for ties (1, 2, 2, 4)', function () {
      const rows = [{ id: 'a', v: 100 }, { id: 'b', v: 50 }, { id: 'c', v: 50 }, { id: 'd', v: 10 }];
      const ranks = rank_(rows);
      assertEqual_(ranks.a, 1, 'a is 1st');
      assertEqual_(ranks.b, 2, 'b ties at 2nd');
      assertEqual_(ranks.c, 2, 'c ties at 2nd');
      assertEqual_(ranks.d, 4, 'd skips to 4th — NOT 3rd');
    });

    t('handles a three-way tie', function () {
      const rows = [{ id: 'a', v: 5 }, { id: 'b', v: 5 }, { id: 'c', v: 5 }, { id: 'd', v: 1 }];
      const ranks = rank_(rows);
      assertEqual_(ranks.a, 1, '');
      assertEqual_(ranks.b, 1, '');
      assertEqual_(ranks.c, 1, '');
      assertEqual_(ranks.d, 4, 'next rank after a three-way tie for 1st is 4th');
    });

    t('treats missing and zero values as zero, still ranked', function () {
      const rows = [{ id: 'a', v: 10 }, { id: 'b' }, { id: 'c', v: 0 }];
      const ranks = rank_(rows);
      assertEqual_(ranks.a, 1, '');
      assertEqual_(ranks.b, 2, 'agents with no deals are ranked, not omitted');
      assertEqual_(ranks.c, 2, 'zero ties with missing');
    });

    t('is stable across runs for tied rows', function () {
      const rows = [{ id: 'z', v: 5 }, { id: 'a', v: 5 }];
      assertEqual_(rank_(rows).a, rank_(rows.slice().reverse()).a,
        'input order must not change the rank');
    });

    t('handles a single row and an empty set', function () {
      assertEqual_(rank_([{ id: 'a', v: 1 }]).a, 1, 'single row ranks 1');
      assertEqual_(Object.keys(rank_([])).length, 0, 'empty set produces no ranks');
    });
  });

  suite_(results, 'Lib.isoWeek', function (t) {

    t('week 1 of a year starting mid-week', function () {
      // 2026-01-01 is a Thursday, so it belongs to 2026-W01.
      assertEqual_(Lib.isoWeek(new Date(2026, 0, 1)), '2026-W01', '');
    });

    t('early January can belong to the previous ISO year', function () {
      // 2027-01-01 is a Friday; ISO assigns it to 2026-W53.
      assertEqual_(Lib.isoWeek(new Date(2027, 0, 1)), '2026-W53',
        'this is the case that breaks naive week arithmetic');
    });

    t('late December can belong to the next ISO year', function () {
      // 2025-12-29 is a Monday, the first day of 2026-W01.
      assertEqual_(Lib.isoWeek(new Date(2025, 11, 29)), '2026-W01', '');
    });

    t('pads single-digit weeks', function () {
      assertEqual_(Lib.isoWeek(new Date(2026, 1, 10)), '2026-W07', 'zero-padded');
    });
  });

  suite_(results, 'Lib.normKey', function (t) {

    t('normalises whitespace and case for joins', function () {
      assertEqual_(Lib.normKey('  AG-001 '), 'ag-001', '');
      assertEqual_(Lib.normKey('Team  North'), 'team north', 'collapses internal runs');
      assertEqual_(Lib.normKey('AG-001'), Lib.normKey('ag-001 '),
        'the whole point: trailing-space IDs must still join');
    });

    t('handles null, undefined and numbers', function () {
      assertEqual_(Lib.normKey(null), '', '');
      assertEqual_(Lib.normKey(undefined), '', '');
      assertEqual_(Lib.normKey(1001), '1001', 'numeric IDs join as strings');
    });
  });

  report_(results);
  return results;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Ranks a fixture through the real implementation. @return {!Object} id -> rank */
function rank_(rows) {
  const copy = rows.map(function (r) { return { AgentId: r.id, v: r.v }; });
  const out = {};
  Rankings.assignRanks(copy, 'v', function (row, rank) { out[row.AgentId] = rank; });
  return out;
}

function suite_(results, name, body) {
  body(function (testName, fn) {
    try {
      fn();
      results.push({ suite: name, test: testName, pass: true, message: '' });
    } catch (err) {
      results.push({ suite: name, test: testName, pass: false, message: String(err.message || err) });
    }
  });
}

function assertEqual_(actual, expected, note) {
  if (actual !== expected) {
    throw new Error('expected ' + JSON.stringify(expected) +
                    ', got ' + JSON.stringify(actual) + (note ? ' — ' + note : ''));
  }
}

function report_(results) {
  const failed = results.filter(function (r) { return !r.pass; });
  const lines = results.map(function (r) {
    return (r.pass ? 'PASS  ' : 'FAIL  ') + r.suite + ' › ' + r.test +
           (r.pass ? '' : '\n        ' + r.message);
  });
  lines.push('');
  lines.push(results.length - failed.length + '/' + results.length + ' passed');

  console.log(lines.join('\n'));
  Lib.log(failed.length ? 'ERROR' : 'INFO', 'Tests',
    (results.length - failed.length) + '/' + results.length + ' passed' +
    (failed.length ? '; failures: ' + failed.map(function (f) { return f.test; }).join(', ') : ''));
}
