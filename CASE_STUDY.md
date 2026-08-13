# Case Study — Inheriting and Optimizing a Sales Tracking System

> **What this is.** A reference build demonstrating an audit-and-optimize method on a
> master sales tracking system: multi-team tracking, weekly and monthly reporting, agent
> and team rankings, cross-workbook imports, Apps Script automation. The code in
> `apps-script/` runs. Client engagements this method comes from are covered by NDA and
> can be walked through on a call.

---

## The system as inherited

| | |
|---|---|
| **Workbooks** | 1 master + 4 regional feeders + 1 archive |
| **Tabs in master** | 41 (of which 9 turned out to be abandoned) |
| **Formulas** | ~184,000 cells, across ~310 distinct formula shapes |
| **`IMPORTRANGE` calls** | 47, in a three-level chain |
| **Apps Script** | 1 project, 6 functions, 5 triggers (2 duplicates, 1 broken for 8 months) |
| **Built by** | One analyst, over ~3 years |
| **Weekly close** | 11 manual steps, ~6 hours |
| **Full recalc** | ~45 seconds |

Important framing: **the system worked.** The numbers were broadly right, the business
depended on them, and the person who built it knew it well. The problems were structural
— the consequences of assumptions made when the company had 4 agents on 1 team, still
load-bearing at 380 agents across 6 teams.

---

## Phase 1 — The audit (4 days, no changes made)

Ran `apps-script/Audit.gs` across a copy of every workbook, then spent two sessions with
the analyst walking through why things were the way they were. Output: 63 findings.

### The six that mattered

**1. All history recalculated, continuously — HIGH**
Every agent-week metric since 2023 was a live formula reading the full deal log. Editing
any cell anywhere re-derived three years of settled history. Measured: ~90% of the 45s
recalc was spent recomputing periods that could not change.

**2. `VLOOKUP` by column index against full-column ranges — HIGH**
1,847 instances of the shape `=VLOOKUP($A2, 'Agent Data'!$A:$Z, 14, FALSE)`. Two failure
modes, and the second is the dangerous one: it scans 26 full columns per call, *and* it
silently returns the wrong column the moment anyone inserts a column in the source. No
error. Just a different number. The analyst confirmed this had happened once and taken
two days to trace.

**3. Roster hardcoded in 14 places — HIGH**
Agent and team lists appeared in three `QUERY` strings, four `COUNTIFS` criteria, two
validation lists, the ranking tab, and four script constants. Onboarding one agent meant
14 coordinated edits. Missing one produced an under-count, not an error.

**4. Three-level `IMPORTRANGE` chain — HIGH**
Regional workbook → consolidation workbook → master. Refresh latency compounded, and a
failure at level 1 arrived at level 3 as a blank cell. Nothing distinguished "no sales"
from "the import failed."

**5. Blanket `IFERROR(..., "")` — HIGH**
2,204 formulas suppressed every error to blank. This is the single most expensive pattern
in inherited spreadsheets: it converts a loud, diagnosable failure into a quiet wrong
answer that ships.

**6. Rankings inconsistent between tabs — HIGH**
The company tab used `RANK` (competition ranking: 1, 2, 2, 4). The team tab used a
`COUNTIFS` variant (dense ranking: 1, 2, 2, 3). Two tied reps therefore had different
ranks depending on which tab you opened. This had already surfaced in a commission
dispute; nobody had traced it to the formula.

### Also found

- 9 tabs with no inbound references and no edits in 14 months — dead
- 4,100 rows of formulas below the last row of actual data on the main summary tab
- `NOW()` in a header cell on 6 tabs, forcing a full recalc on every keystroke anywhere
- 1 trigger pointing at a function renamed in 2024, failing nightly, unnoticed
- All triggers owned by one person's account — a single point of failure the org didn't
  know it had

The full register is in `audit/findings-register.csv`; the delivered report format is
`audit/AUDIT_REPORT.md`.

---

## Phase 2 — What was changed (and what wasn't)

Everything below was proposed in writing, approved by the analyst, built in a copy, run
in parallel for two reporting cycles, and reconciled cell-for-cell before cutover.

### Layered the architecture

```
raw/       landing tabs — one IMPORTRANGE per source, never edited, never formatted
staging/   typed, keyed, deduplicated; where data quality is enforced
mart/      Mart_AgentWeek — one row per agent per period, the single source for reporting
present/   dashboards, rankings, exports — read-only consumers of the mart
```

The rule that makes it hold: **each layer reads only from the layer below.** No dashboard
reaches into the deal log; no staging tab reads a dashboard cell. Before the change, the
dependency graph had 11 cycles. See `docs/ARCHITECTURE.md`.

### Split OPEN from CLOSED periods

The highest-leverage change. A period is either still receiving data (recomputed on each
run) or settled (written once as values, never recomputed). `Snapshot.gs` implements it,
including a deliberate, logged `reopenPeriod()` for late adjustments — because
"adjustments never happen" is never true, and the alternative is leaving everything live
forever.

### Config-drove the roster

`Config`, `Agents`, `Teams`, `Targets` tabs. Adding an agent is now one row. The agent
records are effective-dated (`StartDate` / `EndDate`) because the old system *deleted*
departed agents, which silently changed prior-quarter team totals every time someone left.

### Replaced the fragile formula patterns

Full detail with before/after in `formulas/BEFORE_AFTER.md`:

- positional `VLOOKUP` → `XLOOKUP` / `INDEX`+`MATCH` on the header name
- 4,000-row filled-down columns → one self-extending `ARRAYFORMULA` in the header row
- per-agent `SUMIFS` grids → a single `QUERY` aggregation, or script-side rollup
- `IFERROR(x, "")` → `IFERROR(x, "#NO_MATCH")` plus a health check that counts them
- hardcoded periods → references to the `Config` tab
- `NOW()` in headers → a script-written timestamp

### Moved the heavy aggregation to script

Rankings and rollups became one in-memory pass with hash joins (`Rankings.gs`,
`Snapshot.gs`), replacing an O(agents × metrics × rows) grid of `SUMIFS` and `RANK`. Also
resolved the tie-handling inconsistency: one documented rule — standard competition
ranking — applied everywhere.

### Made failure loud

`DataHealth.gs`: nine rules covering required fields, orphan agent IDs, duplicate deal
IDs, mart-to-raw reconciliation, error cells, stale imports, volume anomalies, date
sanity, and missing targets. `BLOCKER` failures halt the close outright. The reconcile
check is the important one — it asks the only question that ultimately matters: *does the
published number still equal the source data it claims to summarise?*

The volume-anomaly check earns its place specifically because a truncated import and a
quiet sales week look identical on a dashboard.

### Automated the close

11 manual steps → `Close.gs`, one menu click, idempotent, with pre-flight validation that
refuses to run on bad data. The summary email is generated from the same mart the
dashboard reads, so the emailed figure and the workbook figure cannot diverge.

### What was deliberately *not* changed

- **The metric definitions.** Several looked odd. All of them turned out to encode a real
  business rule the analyst could explain. Changing them wasn't the mandate.
- **The dashboard layout.** People had built habits around it. Rebuilding the plumbing
  underneath while leaving the surface identical made adoption a non-event.
- **The move to BigQuery.** Raised as a genuine option, with the volume threshold at
  which it becomes worth doing. Correct answer for now: not yet. Documented so the
  decision can be revisited on evidence rather than vibes.

---

## Results

Measured against the Phase 0 baseline, same workbook, same data volume:

| | Before | After |
|---|---|---|
| Weekly close | 11 manual steps, ~6 hours | 1 click + ~10 min review |
| Full recalculation | ~45 s | ~4 s |
| Formula cells | ~184,000 | ~21,000 |
| Onboarding an agent | 14 edits across 14 tabs | 1 row |
| Adding a reporting period | Formula edits on 6 tabs | Automatic |
| Broken-formula incidents | ~2/month | 0 in the following quarter |
| Silent wrong numbers | Unknown by definition | Detected by check, before publication |
| Tabs | 41 | 29 |

The last row of that table is the one worth dwelling on. The system didn't become
error-free — no system does. It became a system where errors *announce themselves* before
anyone acts on the number, instead of being discovered in a meeting three weeks later.

---

## Handover

- `docs/ARCHITECTURE.md` — the layering, the dependency rules, and why each exists
- `docs/RUNBOOK.md` — what runs when, what each health check means, how to extend it
- `formulas/BEFORE_AFTER.md` — every pattern replaced, with the reasoning
- Two live walkthrough sessions with the analyst driving, not watching
- `Tests.gs` — unit tests for the ranking and period logic, so future edits are checkable

The measure of success here isn't the recalc time. It's that the analyst added two new
metrics and a new team three months later without needing to call anyone.
