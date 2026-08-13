# Runbook — Master Sales Tracking

Operational documentation for the internal team. Written to be usable by someone who did
not build the system, at 8am, when something is wrong.

**Owner:** Data & Analytics Manager
**Escalation:** see `AlertRecipients` on the `Config` tab

---

## 1. Normal operation

Nothing here needs a human on a normal week.

| When | What runs | Where to see it |
|---|---|---|
| Daily 05:00 | Health checks → refresh open period → rankings | `Data Health` tab, `_Log` tab |
| Every 12h | Health checks only | `Data Health` tab |
| Monday 07:00 | Weekly close + summary email | Inbox, `Mart_AgentWeek` |
| Sunday 23:00 | Structural audit | `_Audit Findings` tab |

**The one-glance check:** open the `Data Health` tab. All green means the numbers
reconcile to source. That is the whole morning check.

---

## 2. Doing it manually

Everything is on the **Sales Ops** menu. You should never need the script editor.

| Menu item | Use when | Safe to repeat? |
|---|---|---|
| Refresh current period | Numbers look stale, or data was just corrected | Yes |
| Rebuild rankings only | Rankings look wrong but totals are right | Yes |
| Run data health checks | Before trusting anything unusual | Yes |
| Run system audit | Quarterly, or after significant changes | Yes |
| **Close the week…** | Monday, if the trigger didn't fire | **No — advances state.** Confirms first |
| Reopen a closed period… | A late adjustment must flow into a closed week | Yes, but logged |
| Admin → Trigger status | Automation seems not to be running | Yes |
| Admin → Install/repair triggers | Trigger status shows MISSING or DUPLICATED | Yes |

---

## 3. Health checks — what each one means

`Data Health` tab. **BLOCKER** failures stop the weekly close; **WARN** does not.

| Check | Fails when | Do this |
|---|---|---|
| **Required fields present** `BLOCKER` | A deal row is missing DealId, AgentId, CloseDate or Amount | Fix at source, then Refresh. The Examples column gives row numbers |
| **Every AgentId exists in roster** `BLOCKER` | A deal references an agent not on the `Agents` tab | Add the agent (with `StartDate`), or fix the typo at source. Their revenue is currently excluded from every rollup |
| **No duplicate DealId** `BLOCKER` | The same DealId appears twice | Find both rows (given in Examples), delete the wrong one at source. Revenue is double-counted until you do |
| **Mart total reconciles to raw** `BLOCKER` | The mart and the deal log disagree by more than the tolerance | Usually means a stale mart — Refresh. If it persists after a refresh, escalate: this is the check that says a published number is wrong |
| **No error values in key tabs** `BLOCKER` | A `#REF!`, `#N/A` etc. exists in a scanned tab | Go to the cell listed. A `#REF!` usually means a deleted row or column |
| **Imported data is current** `WARN` | Newest record older than `MaxImportAgeHours` (default 26) | Open the source workbook and confirm it is updating. A silent import failure is the usual cause |
| **Row volume within normal range** `WARN` | Row count deviates >40% from the recent average | A big *drop* is usually a truncated import, not a quiet week. Verify before publishing anything |
| **No future-dated or ancient deals** `WARN` | A CloseDate is in the future, absurdly old, or stored as text | Text dates are the common one — they silently drop out of every period filter |
| **Targets exist for open period** `WARN` | An active team has no revenue target for the open period | Add a row to `Targets`. Attainment shows blank until you do |

**If a BLOCKER fails, the close will not run.** That is intentional. Being late is
recoverable; publishing a wrong commission number is not.

---

## 4. Common situations

### "Monday's close didn't run"
1. Check your email for a `[BLOCKED]` alert — it names the failing check.
2. Open `Data Health`, fix what's red, then **Sales Ops → Close the week…**
3. No alert at all? **Admin → Trigger status.** `MISSING` means the trigger is gone —
   reinstall it. Also confirm the owning account is still active: triggers run as
   whoever created them, and a suspended account stops every job silently.

### "A number on the dashboard looks wrong"
1. `Data Health` — if `RECONCILE` passes, the mart matches source, so the disagreement is
   about *definition*, not data.
2. Find the agent-period row in `Mart_AgentWeek` — that is the number the dashboard shows.
3. Filter `Raw_Sales` to that agent and period and compare.
4. If they disagree, run **Refresh current period** and re-check. If they still disagree,
   escalate: the aggregation logic is wrong, which is a code change, not a data fix.

### "An agent is missing from the rankings"
Almost always one of:
- Not on the `Agents` tab → `ORPHAN_AGENT` will be failing
- `Active = FALSE`, or an `EndDate` before the period
- Their deals have a different AgentId spelling at source

### "We need to change a closed week"
1. **Sales Ops → Reopen a closed period…**, enter the period key (e.g. `2026-W07`)
2. Correct the data at source
3. **Refresh current period**
4. **Close the week…** to re-freeze it

Reopening is logged to `_Log`. If a figure has already been published externally, tell
whoever published it — the point of closing periods is that published numbers don't move
silently.

### "It's slow again"
Run **Run system audit** and read `_Audit Findings`, highest severity first. The usual
culprits after a clean-up:
- a new filled-down formula that should be an `ARRAYFORMULA` (look for "filled down N rows")
- a `NOW()` or `TODAY()` someone added to a cell
- the open period never being closed, so everything stays live

---

## 5. Extending the system

### Add an agent
One row on `Agents`: `AgentId | AgentName | TeamId | StartDate | EndDate | Active`.
Leave `EndDate` blank. Nothing else. Next refresh picks them up.

### An agent leaves
Set `EndDate`. **Do not delete the row** — deleting it retroactively changes every closed
period they contributed to.

### Add a team
One row on `Teams`, plus a `Targets` row for the open period. Agents point at it by
`TeamId`.

### Add a metric
1. Add the field to the aggregation in `Snapshot.computePeriod()`
2. Add it to `COLUMNS` in `Snapshot.gs`
3. If it should be ranked, add it to `METRICS` in `Rankings.gs`
4. Run **Refresh current period**

Historical periods will show blank for the new metric until reopened and recomputed —
which is correct, not a bug. The data didn't exist then.

### Add a health check
Add a function to `DataHealth.gs` and register it in the `CHECKS` array with a severity.
Follow the existing shape: return `{ pass, detail, rows }`. Start new checks at `WARN` and
promote to `BLOCKER` once you've seen a few weeks of real behaviour — a new check that
blocks the close on its first run is how people learn to distrust the checks.

### Change commission tiers
Edit the `CommissionTiers` tab. No formula changes. Keep it sorted descending by
`MinAmount` within each segment.

---

## 6. Things that will bite you

- **Triggers belong to a person.** They run as whoever created them. If that person
  leaves, everything stops silently. Use a shared service account and record who owns it.
- **Never type over a raw landing tab.** The next import reverts it, and the fix vanishes
  with no record.
- **`IMPORTRANGE` fails quietly.** That's why `STALE_IMPORT` and `VOLUME` exist. Trust
  them over the dashboard looking normal.
- **Don't delete agents.** End-date them. (Said twice on purpose.)
- **Don't leave periods open indefinitely.** Every open period recalculates forever. The
  close is what keeps the system fast.
- **Don't reintroduce `IFERROR(x, "")`.** It looks tidier and it hides the exact failures
  the health checks exist to catch. Use a typed marker.
- **The mart is the source for reporting, not `Raw_Sales`.** Building a new dashboard
  directly off the deal log reintroduces the O(n²) problem the mart was built to solve.

---

## 7. Where things are

| Thing | Location |
|---|---|
| Settings, thresholds, alert recipients | `Config` tab |
| Roster | `Agents`, `Teams` tabs |
| Targets | `Targets` tab |
| Deal log (staging) | `Raw_Sales` tab |
| Aggregated reporting data | `Mart_AgentWeek` tab |
| Closed history | Archive workbook (`ArchiveSpreadsheetId` in `Config`) |
| Script execution log | `_Log` tab (hidden) |
| Health check history | `_Health History` tab (hidden) |
| Structural audit output | `_Audit Findings`, `_Audit Summary` tabs |
| The schedule | `Triggers.gs` → `SCHEDULE` |
| Why it's built this way | `docs/ARCHITECTURE.md` |
| What the formulas replaced | `formulas/BEFORE_AFTER.md` |
