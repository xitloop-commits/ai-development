# 14b — TCS2 live session test plan

**Written 2026-09-25 03:00. For the FIRST live trading session.**

Everything in TCS2 has been verified against a **closed** market or synthetic
tapes. 425 tests pass and the design is settled (spec 14, D1–D50), but nothing has
yet seen a real open, real volume, or a real chain moving. This plan is the list
of things only a live session can answer.

> **The next session is TODAY, Friday 2026-09-25** — MCX opens 09:00, NSE 09:15.
> Saturday and Sunday have no session, so if this slips past Friday the next
> chance is **Monday 2026-09-28**.

**Before anything: TCS2 replaces TFA for the day.** Four TCS2 processes take four
of the five Dhan connection slots (D1/D10), so TFA must not run — and with TFA
down, **SEA and blast sit idle** (D31, paused not retired). That is the cost of
the test day, and it is deliberate.

---

## How to read this

Each check has **what to do**, **what pass looks like**, and **what it would mean
if it fails**. Work down in clock order. Nothing later depends on running the
earlier ones, so a check can be skipped without breaking the rest.

A failure is not a disaster — it is the point. Every bug found so far
(T185's truncation, the frozen MCX spot, the −1 sentinel, the premature
end-of-day write, the same-day Dhan 400) came from running the thing rather than
reasoning about it.

---

## Phase A — before the open (08:40–08:54)

### A1. Make sure TFA is not going to start
    powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'Lubas-*' | Select TaskName,State"

**Pass:** the TFA/start tasks are `Disabled`.
**If not:** disable them, or TCS2's first subscribe will hit `805 Too many
connections` and you will learn nothing about TCS2.

### A2. Confirm no TCS2 process is already holding a lock
    dir data\tcs2\locks

**Pass:** empty, or only `.stop` files.
**If a `.pid` is there:** `startup\tcs2.bat <instrument> --stop`, or delete the
file if you are certain the process is gone (D45 detects stale locks, but do not
guess).

### A3. Refresh the contract list and check the counts
    set PYTHONPATH=python_modules
    python -m tcs2.resolve_cli --refresh

**Pass:** four instruments, each inside its expected range, each **1 connection**:
nifty ~1,500 · banknifty ~1,442 · crude ~786 · gas ~356, total ~4,070.
**Watch for:** nifty's expiry list. 2026-09-29 is the last Tuesday, so this
week's weekly **is** the monthly (D26) — expect three monthlies, not a weekly plus
two monthlies. That is correct, not a bug.
**If a count is out of range:** a chain changed size or an expiry rolled. Read the
printed expiries before assuming code is wrong.

---

## Phase B — the open (08:54–09:20)

### B1. Start one instrument first, and watch it alone
    startup\tcs2.bat nifty50

Start **only nifty50** to begin with. It is the largest leg count and the one
carrying three chains, so if anything breaks on subscribe it breaks here.

**Pass, within ~30 seconds:**
- a window opens, health row at the top
- `feed` dot green, `gui` dot green
- `legs` climbing toward 1,49x / 1,500
- **no `804`** in the health row

> **B1 is the single most important check in this plan.** 1,500 legs on one
> connection has only ever been proven on a *quiet* socket (D37). A busy open is
> the real test of D13 — one connection per process, always.

**If `804 Instruments exceed limit` appears:** D13 is wrong and the whole
connection plan needs revisiting. Stop, note the leg count, and do not start the
other three.

### B2. Confirm the recorder starts writing
Watch the health row's `recorder` dot.

**Pass:** it turns green within seconds of the first ticks, and `rows` climbs.
**If it stays `idle` once ticks are flowing:** the write queue is not draining —
check `data\tcs2\ticks\<today>\` for a growing file.

### B3. Start the other three
    startup\tcs2.bat banknifty
    startup\tcs2.bat crudeoil
    startup\tcs2.bat naturalgas

**Pass:** four windows, four green feeds, no `805 Too many connections`.
**If `805`:** something else is holding a Dhan slot — most likely TFA (see A1).

### B4. The tick rate under load
Read `ticks (N/s)` on each health row about ten minutes after the open.

**Pass:** any steady number. There is no target — **this measurement does not
exist yet**. Everything so far was a market-closed snapshot burst of ~3,000
packets. Write the number down.

---

## Phase C — during the session

### C1. The OPTION CHAIN button — the one check that validates our maths
Press **`c`**, or the button top-right, on the nifty window. Put your broker's
option chain next to it.

Compare, strike by strike near the money:

| our column | against the broker's | what a mismatch means |
|---|---|---|
| OI, OI change | their OI | our chain build is wrong |
| LTP, bid, ask | their quotes | a feed or parse problem |
| **IV** | their IV | **our solver or our forward is wrong** |
| delta, gamma | their Greeks | same |

**Pass:** near-the-money IVs within a few tenths of a percent; deltas within
~0.02; OI matching.

> **This is why D38 exists.** We *build* the chain from ticks (D12) and *compute*
> every Greek ourselves (D25) — nothing else in the design checks those numbers
> against an independent source. If IV is systematically off, suspect the
> **forward** first (D40): it is derived from put-call parity, and a bad forward
> shifts every IV in the chain the same way.

**Expected and correct:** some far strikes show **blank** IV, not 0. On a test
chain 195 of 1,484 legs carried no volatility information at all (D39). A blank
means we declined to answer; a 0 would be a lie.

### C2. Bookless prints — the T195 number nobody has ever measured
Read `bookless` on the health row (it only appears when non-zero).

**Pass:** any number. **This is the measurement T195 is waiting for.**
Both TFA and claude_cohort count a print with no order book as a *passive* trade
while their own comments call it *missing data*, which dilutes every buy/sell
share. TCS2 counts them separately. If this number is large, T195 matters; if it
is near zero, T195 is a curiosity.

Note it at the open and again mid-session — depth is most often missing at the
open, so expect it to grow early then flatten.

### C3. The forward, against the futures
On the nifty window, compare the per-expiry `forward` against the futures price
in the header.

**Pass:** the near-month forward sits close to the futures, and later expiries
are progressively higher. Verified closed at **23,095.27 vs 23,095.0**.
**If the forward is wildly off:** put-call parity is reading illiquid strikes.

### C4. Does the screen stay responsive?
Just use it. Open the chain window, switch expiries, leave it for an hour.

**Pass:** the health row's `analytics` stays in tens of milliseconds, `gui` stays
green, and — critically — `ticks` keeps climbing while you interact.
**This is D16 under real load.** A test proves a stalled reader does not throttle
the feed; this is whether that holds with 4,070 legs actually moving.

### C5. Restart one instrument mid-session — deliberately
Pick **naturalgas** (smallest, least interesting).

    startup\tcs2.bat naturalgas --stop
    (wait for the window to close)
    startup\tcs2.bat naturalgas

**Pass:**
- "stopping: sealing the recording" appears
- the window closes and the lock is released
- it comes back within ~5 seconds showing live prices
- **the recording file still reads end to end** (check in Phase E)

**What is expected to be wrong after a restart:** today's `oi_open` per strike,
cumulative delta, and session high/low. Those come only from replaying the day's
own file, which is not yet wired in. If the OI-change column looks wrong after
the restart, that is the known gap, not a new bug.

### C6. Leave the other three alone
Resist restarting nifty, banknifty or crude. A clean, uninterrupted recording for
those three is more valuable than any extra check.

---

## Phase D — the closes

### D1. 15:30 — the NSE pair
Watch nifty and banknifty at 15:30–15:40.

**Pass:**
- the health dots go **`idle`**, not `dead`, once ticks stop (D47 — session-aware)
- end-of-day rows are written **once**, shortly after the close

Check:
    python -c "from tcs2.store import Store, EOD; s=Store(); print(s.db[EOD].count_documents({'meta.inst':'nifty50'}))"

**Pass:** ~1,400–1,500 rows, `src=feed`.
**If 1 row:** the premature end-of-day bug is back (it wrote an almost-empty
chain). It was fixed by requiring the session to have *ended while we watched*.

### D2. 15:35 — do the NSE processes stop cleanly?
If the scheduled tasks are enabled they stop themselves. Otherwise:

    startup\tcs2.bat nifty50 --stop
    startup\tcs2.bat banknifty --stop

**Pass:** "sealing the recording", window closes, lock gone.

### D3. 23:30 — the MCX pair
Same as D1/D2 for crude and gas. **This is the one MCX-specific check:** their
session runs 14.5 hours, so it is the longest any TCS2 process will have run, and
the most memory it will have accumulated.

**Watch:** the `queue_high_water` in the health file. If the write queue built a
backlog over 14 hours, the disk could not keep up.

---

## Phase E — after the session

### E1. Is every recording intact?
    set PYTHONPATH=python_modules
    python -c "import glob; from tcs2.recorder import read_json, ReadReport, is_readable_by_standard_gzip; \
      [print(f, len(list(read_json(f, (r:=ReadReport())))), 'rows,', r.members, 'chunks,', r.damaged_members, 'damaged, std-readable', is_readable_by_standard_gzip(f)) \
       for f in sorted(glob.glob('data/tcs2/ticks/*/*.gz'))]"

**Pass:** `0 damaged`, `std-readable True` for all four.
**If damaged > 0:** D44's sealing did not prevent it — but the tolerant reader
should still recover most of the day. Note how much survived.

### E2. Did the day record itself honestly?
    python -c "from tcs2.store import Store; import json; \
      print(json.dumps(Store().read_daily('nifty50', '2026-09-25')['quality'], indent=1))"

**Pass:** `complete: true`, `coverage` near 1.0, `span_seconds` close to a full
session, `disconnects: 0`.
**This stamp is the point of D29 part 6** — a later study reads it to decide
whether to trust the day, instead of silently averaging a broken one in.

### E3. Did the 25 points record?
    python -c "import glob; from tcs2.recorder import read_json; \
      f=sorted(glob.glob('data/tcs2/analyser/*/nifty50.ndjson.gz'))[-1]; \
      rows=list(read_json(f)); print(len(rows),'rows'); print(rows[len(rows)//2]['verdict'], rows[len(rows)//2]['reasons'])"

**Pass:** roughly one row per minute of session (~375 for NSE), and a mix of
TRADE / NO TRADE verdicts with reasons.
**If every verdict is NO TRADE with "not enough prints":** the analysis is not
seeing the futures flow — check that the futures security id is in the flow map.

**Remember what these rows are for.** They are **not** a track record and must
not be traded on. They exist so that after ~60 live days the points can be scored
against spec 15 §5.5. Not one of the fifteen earlier flow rules survived that
test.

### E4. How much disk did a real day cost?
    dir data\tcs2\ticks\2026-09-25

**Pass:** any number — **the ~1 GB/day estimate has never been checked against a
live day.** It came from TFA's recordings at a different record shape (69 bytes
per tick against our 34). Write the real figure down; it sets the retention
arithmetic in D20.

---

## Phase F — the morning after

### F1. The OI correction catch-up
    startup\tcs2-oi-correct.bat nifty50

**Pass, either of:**
- "not published yet — run again once Dhan has it", **or**
- a corrected count with revisions shown

**Both are passes.** D50 measured Dhan publishing a day's official OI **more than
a night late** — at 02:35 on 2026-09-25 its latest day was 2026-09-23. The job
catches up whenever the day appears, so an early run costs nothing.

**Watch:** the size of the revisions. Crude was out by **15.5%** in the
measurement that prompted this job. If nifty's revisions are large too, the
`feed` versus `official` distinction matters more than assumed.

---

## What "the day went well" means

Not "no failures". It means:

1. **1,500 legs held on one connection through a live open** — D13 proven, not assumed
2. **Four recordings readable end to end**, zero damaged chunks
3. **Our IV and Greeks agreed with the broker's chain** near the money
4. **The quality stamp says `complete: true`** for all four
5. **Real numbers written down** for the three things that have never been
   measured: tick rate under load, bookless-print count, and disk per day

And one more, which is the hardest to remember: **a NO TRADE verdict all day is a
fine result.** The verdict is advisory, unproven, and recorded to be scored — not
followed.

---

## Related
- [14 — TCS2](14_tcs2.md) — the design, D1–D50
- [15 — Detection & Decision](15_detection_decision.md) — the 25 points
- T193 (build), T195 (bookless prints — C2 is its measurement)
