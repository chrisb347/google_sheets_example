# Formula Patterns — Before and After

Every replacement below was proposed, discussed with the system owner, and parallel-run
before cutover. The reasoning matters more than the syntax: these are the patterns that
break inherited sales-tracking systems, and each one fails in a specific, repeatable way.

Assumed layout: `Agents` (roster), `Raw_Sales` (deal log), `Mart_AgentWeek` (aggregated),
`Config` (settings).

---

## 1. Positional lookup → header-name lookup

**Before**
```
=IFERROR(VLOOKUP($A2, 'Agent Data'!$A:$Z, 14, FALSE), "")
```

**After**
```
=IFERROR(
   XLOOKUP($A2, Agents!$A$2:$A, INDEX(Agents!$B$2:$Z, 0, MATCH("TeamName", Agents!$B$1:$Z$1, 0))),
   "#NO_AGENT")
```

**Why.** `14` is a position, not a meaning. Insert a column in `Agent Data` and every one
of these returns a different field — with no error, no `#REF!`, nothing. You get plausible
wrong numbers. Matching on the header text means the formula follows the column.

Secondary win: `$A:$Z` scanned 26 full columns per call. Bounded to the two ranges
actually needed.

If the roster column order is stable and you want it simpler, name the range and use
`XLOOKUP($A2, AgentIds, AgentTeams)` — the point is that the reference survives a column
insert.

---

## 2. Filled-down column → one self-extending array formula

**Before** — copied into 4,000 rows
```
B2:  =IF($A2="", "", $A2 * VLOOKUP($C2, Rates!$A:$B, 2, FALSE))
```

**After** — one formula, in the header row
```
B1:  ={"Commission";
       IF($A$2:$A="", "",
          $A$2:$A * IFERROR(XLOOKUP($C$2:$C, Rates!$A$2:$A, Rates!$B$2:$B), "#NO_RATE"))}
```

**Why.** The filled-down version stops at the last row someone remembered to drag to. Row
4,001 is silently uncalculated — and a blank in a `SUM` is not an error, it is a smaller
total. This is the most common source of quietly-wrong reporting I find.

The array version also collapses 4,000 dependency nodes into one, which is where most of
the recalculation saving comes from.

**Caveat worth stating to the owner:** one array formula is harder to debug than 4,000
copies, because you cannot inspect an individual row's result in isolation. That trade is
worth it here, but it is a real trade, and it is why the health checks exist.

---

## 3. `SUMIFS` grid → single aggregation

**Before** — an agents × metrics grid, ~1,200 formulas, each scanning the full log
```
=SUMIFS(Raw_Sales!$F:$F, Raw_Sales!$B:$B, $A5, Raw_Sales!$D:$D, D$1)
```

**After** — one query, or `Snapshot.gs` writing the mart
```
=QUERY(Raw_Sales!$A$2:$H,
       "select B, sum(F), count(A)
        where B is not null and D = date '"&TEXT($D$1,"yyyy-mm-dd")&"'
        group by B label sum(F) 'Revenue', count(A) 'Deals'", 0)
```

**Why.** The grid is O(agents × metrics × rows): 400 agents × 3 metrics × 60,000 rows is
72 million cell reads, on every recalculation. `QUERY` scans once. Above roughly 50k
source rows, moving the aggregation into Apps Script (one pass, hash join, written as
values) beats both — that is what `Snapshot.computePeriod()` does.

---

## 4. Blanket error suppression → typed markers

**Before**
```
=IFERROR(VLOOKUP($A2, Agents!$A:$D, 4, FALSE), "")
```

**After**
```
=IFERROR(XLOOKUP($A2, Agents!$A$2:$A, Agents!$D$2:$D), "#NO_AGENT")
```

**Why.** `IFERROR(x, "")` is the most expensive habit in inherited spreadsheets. It makes
"this agent isn't in the roster", "the import failed", and "this rep genuinely sold
nothing" render identically — as blank — and blanks flow silently into totals.

A typed marker is greppable, countable, and visible. `DataHealth.checkErrorCells` and
`checkOrphanAgents` then turn it into a `BLOCKER` that halts the close.

Rule of thumb: **only suppress an error when you can name the specific expected cause.**
`IFERROR` around a lookup that legitimately misses for new records is fine. `IFERROR`
wrapped around an entire nested expression is a blindfold.

---

## 5. Volatile functions → computed once

**Before** — in a header cell on six tabs
```
=TEXT(NOW(), "yyyy-mm-dd hh:mm") & " — week of " & TEXT(TODAY()-WEEKDAY(TODAY(),2)+1, "dd mmm")
```

**After** — written by script at the end of each run
```
Config!B12  (LastRefreshed, a static timestamp)
=Config!$B$12
```

**Why.** `NOW()` and `TODAY()` are volatile: they mark the whole dependency chain dirty on
*every* edit anywhere in the workbook. Six of them meant every keystroke triggered a full
recalculation cascade. A script-written timestamp is also more honest — it says when the
data was actually refreshed, not when you happened to open the file.

Same argument, more strongly, for `INDIRECT` and `OFFSET`: they are volatile *and* they
defeat dependency tracking, so Sheets cannot tell what depends on what, and a renamed tab
breaks them at runtime rather than at edit time.

---

## 6. Hardcoded periods → config-driven

**Before** — repeated across six tabs
```
=SUMIFS(Raw_Sales!$F:$F, Raw_Sales!$D:$D, ">="&DATE(2026,2,9),
                          Raw_Sales!$D:$D, "<="&DATE(2026,2,15))
```

**After**
```
=SUMIFS(Raw_Sales!$F$2:$F, Raw_Sales!$D$2:$D, ">="&PeriodStart,
                            Raw_Sales!$D$2:$D, "<="&PeriodEnd)
```
with `PeriodStart` / `PeriodEnd` as named ranges pointing at the `Config` tab.

**Why.** A new reporting period should be a row of data, not a Monday-morning
find-and-replace across six tabs — where missing one produces a report silently covering
the wrong week.

---

## 7. Inconsistent ranking → one documented rule

**Before** — two different tabs, two different tie behaviours
```
Company tab:  =RANK(G2, $G$2:$G$500)
Team tab:     =COUNTIFS($G$2:$G$500, ">"&G2, $D$2:$D$500, $D2) + 1
```

**After** — `Rankings.assignRanks()`, standard competition ranking, applied everywhere.

**Why.** Three problems in two formulas:

1. `RANK` gives 1, 2, 2, 4. The `COUNTIFS` variant gives 1, 2, 2, 3. Two tied reps had
   different ranks depending on which tab you opened — which reached a commission
   dispute before anyone traced it to the formula.
2. Both hardcode row 500. Agent 501 is unranked and nothing says so.
3. Both are O(n²): every `RANK` scans the whole column, recalculating on every edit.

One sort in script, one tie rule, stated in the code and in the runbook. A shared
business rule belongs in one place.

---

## 8. `IMPORTRANGE` chains → single landing tabs

**Before** — three levels deep, 47 calls
```
Master!A2:   =IMPORTRANGE("<consolidation_id>", "Combined!A:H")
Consolidation!A2: =IMPORTRANGE("<region_north_id>", "Sales!A:H")
```

**After** — one import per source, straight into a raw landing tab
```
Raw_North!A1:  =IMPORTRANGE("<region_north_id>", "Sales!A1:H")
Raw_South!A1:  =IMPORTRANGE("<region_south_id>", "Sales!A1:H")
Staging_Sales: reads the Raw_* tabs internally — no external calls
```

**Why.** Each `IMPORTRANGE` is an independent refresh with its own latency and its own
failure mode. Chaining them compounds both, and an upstream failure arrives downstream as
a *blank cell* — indistinguishable from real absence.

Flattening to one hop per source means a failure is local, visible, and attributable to a
named tab. `DataHealth.checkStaleImport` then catches the case where a landing tab has
quietly stopped updating.

Where a source is large or an API exists, `UrlFetchApp` on a schedule beats `IMPORTRANGE`
outright: real error handling, real retry, real logging.

---

## 9. Deep nesting → lookup table

**Before**
```
=IF($D2="Enterprise", IF($F2>100000, 0.12, IF($F2>50000, 0.10, 0.08)),
 IF($D2="Mid-Market", IF($F2>50000, 0.09, 0.07),
 IF($D2="SMB", IF($F2>25000, 0.06, 0.05), 0.04)))
```

**After** — a `CommissionTiers` tab (`Segment | MinAmount | Rate`) plus:
```
=IFERROR(
   INDEX(CommissionTiers!$C$2:$C,
     MATCH(1, ($D2=CommissionTiers!$A$2:$A) * ($F2>=CommissionTiers!$B$2:$B), 0)),
   "#NO_TIER")
```

**Why.** The nested version encodes a business rule that Finance owns inside a formula
only one person can read. When the rates change — and they change — someone edits a
nested `IF` under time pressure. As a table, the rule is visible, reviewable by the people
who actually own it, and changeable without touching a formula.

*(Note the tiers table must be sorted descending by `MinAmount` within each segment for
the `MATCH` to select the correct band — documented on the tab itself.)*

---

## Quick reference

| Pattern | Failure mode | Replace with |
|---|---|---|
| `VLOOKUP(…, 14, FALSE)` | Wrong column, silently, after an insert | `XLOOKUP` / `INDEX`+`MATCH` on header name |
| Filled-down formula | Stops at last dragged row | Self-extending `ARRAYFORMULA` |
| `A:A` inside a filled-down formula | O(n²) recalculation | Bounded range or single aggregation |
| `SUMIFS` grid | O(agents × metrics × rows) | `QUERY`, or script-side rollup |
| `IFERROR(x, "")` | Wrong number instead of an error | Typed marker + health check |
| `NOW()` / `TODAY()` in cells | Full recalc on every edit | Script-written timestamp |
| `INDIRECT` / `OFFSET` | Breaks on rename; untrackable | Direct or named range |
| Hardcoded dates | Wrong-period reports | `Config` tab + named ranges |
| `RANK` over a hardcoded range | Unranked rows past the limit; tie mismatch | Script ranking, one documented rule |
| Chained `IMPORTRANGE` | Failures arrive as blanks | One landing tab per source |
| Deeply nested `IF` | Business rule nobody can review | Lookup table |
