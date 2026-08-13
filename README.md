# Example Project — Sales Ops Master System

A reference build showing the audit-and-optimize method end to end: what the audit found,
what changed, and the code that replaced the manual work.

> **What this is.** A demonstration system built to make the method concrete — realistic
> structure, running code, not a client's confidential workbook. Real engagements this
> method comes from are under NDA and can be walked through on a call.

---

## Read in this order

| | |
|---|---|
| 1. [`CASE_STUDY.md`](CASE_STUDY.md) | The narrative: system as inherited, what the audit found, what changed, measured results |
| 2. [`audit/AUDIT_REPORT.md`](audit/AUDIT_REPORT.md) | A Phase 1 deliverable in the format a client actually receives |
| 3. [`audit/findings-register.csv`](audit/findings-register.csv) | The ranked register — importable straight into Sheets |
| 4. [`formulas/BEFORE_AFTER.md`](formulas/BEFORE_AFTER.md) | Nine formula patterns replaced, with the failure mode each one caused |
| 5. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The layered target architecture and the four rules that hold it together |
| 6. [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | The operational handover doc |
| 7. [`apps-script/`](apps-script/) | The implementation |

---

## The code

| File | Lines | What it does |
|---|---|---|
| `Lib.gs` | ~200 | Locking, retry, structured logging, batched read/write, alerting |
| `Config.gs` | ~160 | Config/Agents/Teams/Targets as the single source of truth |
| `Audit.gs` | ~380 | **The scanner.** Read-only structural audit → `_Audit Findings` |
| `DataHealth.gs` | ~320 | Nine validation rules; BLOCKER failures halt the close |
| `Snapshot.gs` | ~240 | OPEN/CLOSED period split — the main performance win |
| `Rankings.gs` | ~240 | Script-side ranking, one documented tie rule, no row limit |
| `Close.gs` | ~150 | The weekly close as one idempotent operation |
| `Triggers.gs` | ~130 | Declarative schedule; drift detection |
| `Menu.gs` | ~200 | Operator UI — nobody should need the script editor |
| `Bootstrap.gs` | ~380 | Builds a working demo from an empty sheet; injects and repairs realistic data faults |
| `Tests.gs` | ~230 | 20 unit tests: ranking ties, ISO week arithmetic, period round-trips, data generation |

**Start with `Audit.gs`.** It's the piece that does the work everything else depends on:
inventory before opinion. It runs read-only against any workbook, needs no configuration,
and writes only its own two report tabs.

---

## Running it — about 5 minutes

1. New Google Sheet → **Extensions → Apps Script**
2. Add each `.gs` file with the same names (load order doesn't matter; all cross-file
   references happen at call time)
3. Save, reload the sheet → the **Sales Ops** menu appears
4. **Sales Ops → Demo → Build demo system**

That's it. `Bootstrap.gs` creates every tab and generates 24 agents across 5 active teams,
six weeks of deals, targets, closed history, a populated mart and live rankings. It
refuses to run if the tabs already contain data, so it can't be pointed at a real workbook
by accident.

Data is generated from a fixed seed, so every run produces identical figures — a demo can
be rehearsed, and two people looking at two copies see the same numbers.

### The 2-minute walkthrough

The thing worth demonstrating isn't that it's fast. It's that a wrong number can't reach a
report unnoticed.

| Step | Do | What to point at |
|---|---|---|
| 1 | **Demo → Build demo system** | `Rankings` — ranks, team rollups, movement arrows vs the prior week |
| 2 | **Run data health checks** | `Data Health` — nine checks, all green. `RECONCILE` is the one that matters: the mart still equals the source |
| 3 | **Demo → Inject data faults** | Four realistic problems: an unknown agent ID, a duplicated deal, a text-formatted date, a missing amount |
| 4 | **Run data health checks** | Three blockers fire, naming the exact rows and IDs. In the old system all four of these published silently |
| 5 | **Close the week…** | It refuses, and says why. Being late is recoverable; a wrong commission figure isn't |
| 6 | **Demo → Repair data faults** | Green again, mart and rankings rebuilt |
| 7 | **Run system audit** | `_Audit Findings` — the scanner's output on a healthy workbook |

Before using any of this on a real system, delete the **Demo** submenu from `Menu.gs`.

`Audit.gs` also runs standalone against *any* workbook — no config, no other files, writes
only its two report tabs. That's deliberate: it's the first thing to run on a system you
don't know yet.

### Tabs

Created for you by the bootstrap. Listed here because you'll need them if you're wiring
this to real data instead.

| Tab | Columns |
|---|---|
| `Config` | `Key`, `Value`, `Notes` |
| `Agents` | `AgentId`, `AgentName`, `TeamId`, `StartDate`, `EndDate`, `Active` |
| `Teams` | `TeamId`, `TeamName`, `RegionId`, `ManagerEmail`, `Active` |
| `Targets` | `PeriodKey`, `ScopeType`, `ScopeId`, `Metric`, `TargetValue` |
| `Raw_Sales` | `DealId`, `AgentId`, `DealType`, `CloseDate`, `PeriodKey`, `Amount`, `ImportedAt` |
| `Mart_AgentWeek` | header row only — written by `Snapshot.gs` |

Created automatically on first run: `Data Health`, `Rankings`, `_Log`, `_Health History`,
`_Audit Summary`, `_Audit Findings`.

### Config keys

| Key | Example | Purpose |
|---|---|---|
| `OpenPeriodKey` | `2026-W07` | The period currently being recomputed |
| `RawSalesTab` | `Raw_Sales` | Staging tab name |
| `MartSheetTab` | `Mart_AgentWeek` | Mart tab name |
| `PrimaryRankMetric` | `Revenue` | Metric the headline ranking sorts by |
| `RequiredDealFields` | `DealId,AgentId,CloseDate,Amount` | Enforced by `REQ_FIELDS` |
| `ReconcileToleranceAbs` | `0.01` | Raw-vs-mart tolerance |
| `MaxImportAgeHours` | `26` | Staleness threshold |
| `VolumeDeviationThreshold` | `0.4` | Row-count anomaly sensitivity |
| `ErrorScanTabs` | `Raw_Sales,Mart_AgentWeek` | Tabs scanned for error values |
| `AlertRecipients` | `ops@example.com` | Health-check failure alerts |
| `SummaryRecipients` | `leadership@example.com` | Weekly close summary |
| `ArchiveSpreadsheetId` | *(blank)* | Optional history workbook |
| `HealthHistoryTab` | `_Health History` | Volume baseline store |
| `RunbookUrl` | *(blank)* | Opened from the Admin menu |

### Tests

Run `runTests()` from the editor. All 20 need no workbook data — they exercise pure logic
(ranking ties, ISO week arithmetic, period round-trips, join-key normalisation, data
generation), which is exactly the category where a bug produces a plausible wrong number
instead of a crash.

The round-trip test earns its place: if `Bootstrap.mondayOf` and `Lib.isoWeek` ever
disagree, deals land in the wrong week and every downstream total is quietly wrong — with
nothing on screen looking unusual.

---

## Design decisions worth defending

Things a reviewer might reasonably question:

**Why script the rankings instead of using `RANK`?** Three reasons, in order: the two tabs
disagreed on tie handling (a correctness bug that reached a commission dispute), `RANK`
over a hardcoded range silently unranks anything past the limit, and it's O(n²) recomputed
on every edit. One sort in script fixes all three and makes the tie rule explicit enough
to unit-test.

**Why not move everything to script?** Because the internal team maintains this. Dashboard
formulas stay formulas — visible, traceable, editable by the person who owns them. Script
is for what must be *correct and unattended*; formulas are for what must be *visible and
adjustable*.

**Why do health checks block the close?** Being late is recoverable. Publishing a wrong
commission figure is not. The check that matters most is `RECONCILE` — it asks whether
the published number still equals the source data it claims to summarise, which is the
only question a reporting system ultimately has to answer.

**Why is `reopenPeriod()` there at all?** Because "we never adjust closed periods" is
never true, and the alternative to a controlled, logged reopen is leaving every period
live forever — which is the exact problem the snapshot design exists to solve.

**Why does the audit run on a schedule?** A system audited once is clean for about a
quarter. Running it weekly turns a one-time cleanup into a standing signal, so
reintroduced fragility is visible while it's still cheap to discuss.
