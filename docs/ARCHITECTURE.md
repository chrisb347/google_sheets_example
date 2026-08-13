# Architecture

The target structure, and — more usefully — why each rule exists. Every rule below was
written in response to a specific failure in the system as inherited.

---

## The layers

```
┌─ raw ──────────────────────────────────────────────────────────────────┐
│  Raw_North · Raw_South · Raw_East · Raw_West · Raw_CRM                  │
│  One IMPORTRANGE (or UrlFetchApp pull) per source. Landing zone only.   │
│  Never edited. Never formatted. Never referenced by a dashboard.        │
└────────────────────────────────────────────────────────────────────────┘
                                   ↓
┌─ staging ──────────────────────────────────────────────────────────────┐
│  Raw_Sales                                                              │
│  Union of the raw tabs. Typed, keyed, deduplicated, period-stamped.     │
│  This is where data quality is enforced — DataHealth reads here.        │
└────────────────────────────────────────────────────────────────────────┘
                                   ↓
┌─ mart ─────────────────────────────────────────────────────────────────┐
│  Mart_AgentWeek                                                         │
│  One row per agent per period. OPEN rows recompute; CLOSED rows are     │
│  values, written once, never recalculated.                              │
│  The single source for every downstream number.                         │
└────────────────────────────────────────────────────────────────────────┘
                                   ↓
┌─ presentation ─────────────────────────────────────────────────────────┐
│  Dashboard · Rankings · Monthly · Data Health · exports · charts        │
│  Read-only consumers of the mart. Contain no business logic.            │
└────────────────────────────────────────────────────────────────────────┘

  ┌─ control ──────────────────────────────────────────────────────────┐
  │  Config · Agents · Teams · Targets · CommissionTiers                │
  │  Read by every layer. Written only by humans (and OpenPeriodKey     │
  │  by the close job). The only place a business fact is defined once. │
  └────────────────────────────────────────────────────────────────────┘
```

---

## The four rules

### 1. Each layer reads only from the layer below it

The dependency graph as inherited had **11 cycles** — a dashboard cell feeding a staging
calculation that fed the dashboard. Cycles make change impossible to reason about: you
cannot answer "what breaks if I edit this?" and so, eventually, nobody edits anything.

Layering makes that question answerable by inspection. It is the rule that all the others
depend on.

### 2. Raw is immutable

Nothing edits a raw landing tab. Not a formula, not a person, not a script. If source
data is wrong, it is fixed at the source, or corrected in staging with the correction
recorded as data.

The reason: as inherited, people fixed bad imported rows by typing over them. That works
until the import refreshes and silently reverts the fix — or doesn't, and now the
spreadsheet and the source of record disagree with no record of why.

### 3. A period is OPEN or CLOSED

- **OPEN** — still receiving data. Recomputed on every run.
- **CLOSED** — settled. Written once as values. Never recomputed.

This is the single highest-leverage decision in the design. It removed ~90% of the
recalculation cost, and it also gives the business something it did not have before: a
defensible statement that last month's published numbers have not moved since publication.

Reopening is supported (`Snapshot.reopenPeriod`) because late adjustments are real. It is
deliberately explicit and logged — an event people can see — rather than the default state
of everything.

### 4. Business facts live in the control layer, once

Rosters, targets, commission tiers, period definitions, thresholds, alert recipients. If a
fact appears in two places, it will eventually disagree with itself. As inherited, the
roster appeared in 14 places, and it did disagree with itself.

Practical test: **"can a non-technical person change this without opening a formula?"** If
a business rule fails that test, it is in the wrong place.

---

## Where logic belongs

Not everything should be script, and not everything should be formulas. The dividing line
that has held up in practice:

| Use | For | Because |
|---|---|---|
| **Formulas** | Presentation, light derivation, anything a user should be able to see and trace | Transparent, immediate, and the internal team can already maintain them |
| **Array formulas** | A whole-column derivation from a single source | Self-extending, one dependency node instead of thousands |
| **`QUERY`** | Aggregation of a few thousand rows | Declarative and readable; scans once |
| **Apps Script** | Anything crossing tabs or periods, anything scheduled, anything that must not silently half-succeed | Testable, loggable, atomic, no row limit |

**The rule of thumb:** if it must be *correct and unattended*, script it. If it must be
*visible and adjustable*, keep it a formula.

Deliberately, the dashboards stayed formulas. Moving them to script would have made them
opaque to the team who own them, for no real gain.

---

## What is scheduled

Declared in `Triggers.gs`; the code is the schedule.

| When | Job | Does |
|---|---|---|
| Daily 05:00 | `trigger_dailyRefresh` | Health checks → refresh open period → rebuild rankings |
| Monday 07:00 | `trigger_weeklyClose` | Full close: freeze the week, advance the period, email the summary |
| Every 12h | `runDataHealth` | Health checks only; alerts on failure |
| Sunday 23:00 | `trigger_nightlyAudit` | Re-runs the structural audit so drift is visible |

That last one matters more than it looks. A system that has been audited once is clean
for about a quarter. Running the audit on a schedule turns "we cleaned this up in 2026"
into a standing signal — you can see fragile patterns being reintroduced while it is still
cheap to discuss.

**Triggers run as the account that created them.** For a business-critical system they
belong to a shared service account, not an individual. This is the failure mode nobody
plans for: someone leaves, their account is suspended, and every scheduled job stops
without an error anywhere.

---

## Failure model

The design assumption is that things will break. The goal is that breakage is **loud,
local, and attributable**.

| Failure | Old behaviour | New behaviour |
|---|---|---|
| Import fails | Blank cells; looks like a slow week | `STALE_IMPORT` warning + `VOLUME` anomaly; named tab |
| Unknown agent ID | Revenue silently excluded from rollups | `ORPHAN_AGENT` blocker; close halted |
| Deal logged twice | Revenue double-counted | `DUP_DEAL` blocker; both row numbers reported |
| Formula breaks | `IFERROR` renders it blank | Typed marker + `ERROR_CELLS` blocker |
| Mart drifts from raw | Undetectable | `RECONCILE` blocker with the exact delta |
| Script fails | Visible only in the executions view | `_Log` row + email alert |
| Two jobs run at once | Interleaved partial writes | `LockService`; second run skips and logs |

The reconciliation check is the one that matters most. Everything else is a proxy for the
only question that counts: **does the published number still equal the source data it
claims to summarise?**

---

## Scale

Current: ~60k deal rows/year, ~380 agents, 6 teams.

| Threshold | Signal | Response |
|---|---|---|
| ~250k rows in the live workbook | Refresh > 60s | Archive more aggressively; keep 13 weeks live |
| ~500k rows | Archiving no longer sufficient | Move staging + mart to BigQuery; keep Sheets as the presentation layer |
| Sub-second dashboard latency required | A product requirement, not a data one | Looker Studio over BigQuery |
| > 6M allocated cells | Approaching the 10M hard limit | Split the archive workbook by year |

Written down so the migration decision is made on a measurement rather than a feeling.
**Today, Sheets is the right tool** — a migration would cost more than every finding in
the audit combined, and the team already knows this one.
