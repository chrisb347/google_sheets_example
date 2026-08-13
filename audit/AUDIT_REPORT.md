# System Audit — Master Sales Tracking

**Phase 1 deliverable** · Prepared for the Data & Analytics Manager
**Scope:** 1 master workbook, 4 regional feeders, 1 archive · 41 tabs · ~184,000 formula cells
**Method:** read-only scan (`apps-script/Audit.gs`) against a full copy, plus two interview sessions
**Changes made to production during this phase:** none

---

## 1. Executive summary

The system is sound in its logic and materially at risk in its structure. Nothing here is
a criticism of how it was built — every issue below is the normal consequence of a system
that grew from 4 agents on 1 team to 380 agents across 6 teams while continuously in use.

**Three findings account for most of the risk:**

1. **All history recalculates, continuously.** ~90% of the 45-second recalculation is
   spent recomputing periods that closed months ago and cannot change.
2. **Failures are silent.** 2,204 formulas suppress errors to blank. A failed import, an
   unknown agent, and a genuinely quiet week are indistinguishable on the dashboard.
3. **Growth requires coordinated manual edits.** Adding an agent means 14 edits across 14
   tabs. Missing one produces an under-count, not an error.

**The one thing to fix first, if only one thing gets fixed:** finding **F-01**
(open/closed period split). It is the largest performance win, it is low-risk, and it
makes several other findings cheaper to address afterwards.

**Estimated total remediation:** 9–13 days for all HIGH and MEDIUM findings. The four
HIGH findings alone are ~5 days and remove the majority of the operational risk.

---

## 2. Baseline

| Metric | Measured |
|---|---|
| Full recalculation | 45.2 s (median of 5, cold) |
| Formula cells | 183,940 across 310 distinct shapes |
| Allocated cells (master) | 6.4M of the 10M limit |
| `IMPORTRANGE` calls | 47 across 4 sources, 3 levels deep |
| Volatile function cells | 14,206 |
| `V/HLOOKUP` cells | 1,847 |
| Weekly close | 11 manual steps, ~6 hours |
| Installable triggers | 5 (2 duplicates, 1 broken) |
| Tabs with no inbound references | 9 |

Recorded so that "faster" and "simpler" can be verified rather than asserted at the end
of the engagement.

---

## 3. Findings

Ranked by **blast radius × likelihood**, not by how untidy the code is. A hideous formula
that has been stable for two years and feeds nothing ranks below a tidy one that
under-reports commission.

Full register with all 63 findings: `findings-register.csv`.

### HIGH

#### F-01 · All historical periods recalculate on every edit
**Where:** `Agent Summary`, `Team Rollup`, `Monthly`, `Rankings` — ~112,000 formula cells
**What happens today:** every agent-week metric since 2023 is a live formula reading the
full deal log. Any edit anywhere in the workbook re-derives three years of settled
history.
**Impact:** ~40 s of the 45 s recalculation. Users learn to avoid touching the workbook,
which is its own cost.
**Recommendation:** split periods into OPEN (recomputed) and CLOSED (written once as
values). Closed periods stop recalculating entirely. Provide an explicit, logged reopen
path for late adjustments.
**Effort:** 2 days · **Risk of change:** low — closed values are reconciled against the
live formulas before cutover.

#### F-02 · Positional `VLOOKUP` against full-column ranges
**Where:** 1,847 cells, 12 tabs · e.g. `Agent Summary!D2`
**What happens today:** `=VLOOKUP($A2, 'Agent Data'!$A:$Z, 14, FALSE)`
**Impact:** two failure modes. It scans 26 full columns per call (performance), and it
returns a *different field, with no error*, if anyone inserts a column in the source
(correctness). Confirmed in interview: this has occurred once and took two days to trace.
**Recommendation:** `XLOOKUP` / `INDEX`+`MATCH` resolving the column by header name, over
bounded ranges.
**Effort:** 1.5 days · **Risk of change:** low, mechanical, parallel-runnable.

#### F-03 · Blanket `IFERROR(..., "")` across 2,204 formulas
**Where:** every calculation tab
**Impact:** the highest-consequence finding in the report. It converts diagnosable
failures into quiet wrong answers. There is currently no way to distinguish a broken
lookup from a legitimate zero, which means there is no way to know whether any published
figure was correct.
**Recommendation:** typed markers (`#NO_AGENT`, `#NO_RATE`) plus automated checks that
count them and block the weekly close when any are present.
**Effort:** 1 day (mechanical) + 1 day (health-check layer)
**Risk of change:** low, but expect it to surface pre-existing data problems that were
previously invisible. **That is the point, and it should be socialised before cutover** —
the first week will look worse, because it will finally be honest.

#### F-04 · Agent and team roster hardcoded in 14 locations
**Where:** 3 `QUERY` strings, 4 `COUNTIFS` criteria, 2 validation lists, `Rankings`, 4
script constants
**Impact:** onboarding one agent requires 14 coordinated edits. Missing one silently
excludes that agent's revenue from a rollup. Interview confirmed this has happened.
**Recommendation:** a `Config`/`Agents`/`Teams` tab set as the single source of truth,
read by array formulas and by script. Effective-date agent records so departures stop
retroactively changing closed periods.
**Effort:** 1.5 days · **Risk:** low.

### MEDIUM (summarised — full detail in the register)

| ID | Finding | Impact | Effort |
|---|---|---|---|
| F-05 | 3-level `IMPORTRANGE` chain, 47 calls | Compounded latency; upstream failures arrive as blanks | 1 d |
| F-06 | Ranking tie rules differ between tabs (`RANK` vs `COUNTIFS`) | Same tied reps ranked differently on different tabs — already caused a commission dispute | 0.5 d |
| F-07 | `NOW()` in header cells on 6 tabs | Full recalc cascade on every keystroke | 0.5 d |
| F-08 | 4,100 rows of formulas below the last row of data | Pure recalculation waste | 0.25 d |
| F-09 | Ranking ranges hardcoded to row 500 | Agents past row 500 unranked, no error | 0.25 d |
| F-10 | `Team Rollup!F14` — 612-character formula | Unreviewable; errors survive indefinitely | 0.5 d |
| F-11 | Commission tiers as 8-level nested `IF` | Business rule Finance owns, hidden in a formula | 0.5 d |
| F-12 | 5 triggers: 2 duplicates, 1 pointing at a renamed function | One job runs twice; another has silently failed nightly since 2024 | 0.25 d |
| F-13 | All triggers owned by one individual account | Every scheduled job stops if that account is deactivated | 0.25 d |
| F-14 | 9 tabs with no inbound references, no edits in 14 months | Recalculation and cognitive load for nothing | 0.25 d |

### LOW / INFO

23 findings covering unused allocated cells, inconsistent number formats, unprotected
input ranges, missing named ranges, and inventory. Listed in the register; none are
urgent, several are near-free to fix while doing the work above.

---

## 4. What is working well

Worth stating plainly, because an audit that lists only problems gives a false picture:

- **The metric definitions are correct and consistent.** Several looked wrong on first
  read; each turned out to encode a real business rule that was explained clearly in
  interview. The logic is not the problem here.
- **Raw data capture is clean.** The deal log has a stable schema and a genuine unique
  key. A great deal of the remediation is straightforward *because* of this.
- **The archive discipline is real.** Someone made a deliberate decision to keep an
  archive workbook. It is under-used, but the instinct was right and the target
  architecture builds directly on it.
- **The `QUERY` usage on the regional tabs is good practice** and should be the model for
  what replaces the `SUMIFS` grids elsewhere.

---

## 5. Explicitly not recommended

- **Migrating to BigQuery / Looker Studio.** Raised and considered. At current volume
  (~60k deal rows/year) Sheets is the right tool, and a migration would cost more than
  every finding above combined. Revisit at roughly 500k rows or when sub-second dashboard
  latency becomes a requirement. Documented so the decision is evidence-based later.
- **Rebuilding the dashboards.** People have built habits around the current layout.
  Changing the plumbing underneath while leaving the surface identical makes adoption a
  non-event, which is worth more than a tidier layout.
- **Changing metric definitions.** Not the mandate, and the definitions are sound.
- **Introducing a formal database.** Same reasoning as BigQuery. The `Config`/mart
  structure gives most of the discipline of a schema without leaving the tool the team
  already knows.

---

## 6. Recommended sequence

Ordered so each step reduces the risk of the next, and each is independently valuable —
you can stop after any step and be better off than before it.

| Step | Work | Days | Why here |
|---|---|---|---|
| 1 | F-08, F-07, F-14 — trim dead rows, tabs, volatiles | 1 | Free performance; makes later measurement meaningful |
| 2 | F-04 — config-drive the roster | 1.5 | Everything downstream depends on a single source of truth |
| 3 | F-01 — open/closed period split | 2 | The big performance win; needs step 2 in place |
| 4 | F-03 — typed errors + health-check layer | 2 | Safety net **before** the riskier formula rewrites |
| 5 | F-02 — replace positional lookups | 1.5 | Step 4's checks now verify this parallel-run |
| 6 | F-06, F-09, F-11 — rankings and tiers to script/tables | 1.5 | Resolves the correctness inconsistency |
| 7 | F-05 — flatten the `IMPORTRANGE` chain | 1 | Independent; can run in parallel with 5–6 |
| 8 | F-12, F-13 — declarative triggers, service-account ownership | 0.5 | Locks in the automation |
| 9 | Documentation + handover | 1 | — |

**Note on ordering:** step 4 deliberately precedes step 5. Building the safety net before
the invasive formula changes means the rewrites are verified automatically rather than by
eye. This is the sequencing decision I'd most want to defend in review.

---

## 7. Next step

Review this register together and decide what is in scope. Phase 1 is a genuine exit
point — if you'd prefer to take this list and have the internal team implement it, that's
a good outcome and the report is written to support it.
