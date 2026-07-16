"""
MA-Signal tuning replay — runs the REAL production detector (ma_signal.py) over
recorded spot history and measures, per parameter set:
  • trade count, win rate (favorable spot move at the leg's own exit)
  • average favorable / adverse move
  • big-trend capture (legs whose favorable move >= a "trend" cut, and their sum)

Win/PnL proxy = signed UNDERLYING move over the leg (CE: exit-entry, PE: entry-exit),
in % of spot. Options amplify this by ~delta and pay theta, but for RANKING entry
quality across settings the underlying move is the dominant, honest signal.

No production code/config is touched. Read-only over data/features/*.
"""
from __future__ import annotations
import glob, os, sys
import pandas as pd

sys.path.insert(0, os.path.abspath("python_modules"))
from signal_engine_agent.ma_signal import MASignalDetector
from signal_engine_agent.thresholds import MASignalThresholds

INSTS = {"nifty50": "nifty50_features.parquet", "banknifty": "banknifty_features.parquet"}
TREND_CUT = 0.15  # % spot move that counts as a "real trend" leg (vs chop)


def legs_for_day(ticks, cfg: MASignalThresholds):
    """Replay the detector over one day's (ts, spot) ticks -> list of legs."""
    det = MASignalDetector(cfg)
    open_leg = {}
    legs = []
    last_spot = None
    ts = None
    for ts, spot in ticks:
        last_spot = spot
        for ev in det.on_tick(ts, spot):
            if ev == "LONG_CE":
                open_leg["CE"] = (ts, spot)
            elif ev == "LONG_PE":
                open_leg["PE"] = (ts, spot)
            elif ev == "EXIT_CE" and "CE" in open_leg:
                t0, s0 = open_leg.pop("CE"); legs.append(("CE", t0, s0, ts, spot))
            elif ev == "EXIT_PE" and "PE" in open_leg:
                t0, s0 = open_leg.pop("PE"); legs.append(("PE", t0, s0, ts, spot))
    for side, (t0, s0) in open_leg.items():
        legs.append((side, t0, s0, ts, last_spot))
    return legs


def move_pct(side, s0, s1):
    raw = (s1 - s0) if side == "CE" else (s0 - s1)
    return raw / s0 * 100.0


def minute_ema(ticks, period):
    """Per-minute last-spot closes + an EMA of them, keyed by minute int."""
    closes = {}
    for ts, spot in ticks:
        closes[int(ts // 60)] = spot
    mins = sorted(closes)
    a = 2.0 / (period + 1)
    ema, out = None, {}
    for m in mins:
        ema = closes[m] if ema is None else a * closes[m] + (1 - a) * ema
        out[m] = ema
    return closes, out


def regime_ok(side, entry_ts, closes, ema):
    """Trend filter: CE only in an up regime (close>EMA & EMA rising), PE only in
    a down regime. Skips counter-trend (chop) entries."""
    m = int(entry_ts // 60)
    if m not in ema or (m - 1) not in ema:
        return True
    rising = ema[m] > ema[m - 1]
    above = closes[m] > ema[m]
    return (above and rising) if side == "CE" else ((not above) and (not rising))


def run(cfg: MASignalThresholds, inst_file: str, regime_period: int = 0):
    days = sorted(glob.glob(f"data/features/*/{inst_file}"))
    all_legs = []
    for f in days:
        df = pd.read_parquet(f, columns=["timestamp", "underlying_ltp"]).dropna()
        ticks = list(zip(df["timestamp"].tolist(), df["underlying_ltp"].tolist()))
        if len(ticks) < 100:
            continue
        legs = legs_for_day(ticks, cfg)
        if regime_period:
            closes, ema = minute_ema(ticks, regime_period)
            legs = [lg for lg in legs if regime_ok(lg[0], lg[1], closes, ema)]
        all_legs += legs
    def stats(legs):
        moves = [move_pct(s, s0, s1) for (s, _t0, s0, _t1, s1) in legs]
        if not moves:
            return dict(n=0, win_rate=0, avg_win=0, avg_loss=0, expectancy=0,
                        net=0, trend_n=0, trend_sum=0)
        wins = [m for m in moves if m > 0]
        losses = [m for m in moves if m <= 0]
        trend = [m for m in moves if m >= TREND_CUT]
        return dict(
            n=len(moves),
            win_rate=len(wins) / len(moves) * 100,
            avg_win=sum(wins) / len(wins) if wins else 0,
            avg_loss=sum(losses) / len(losses) if losses else 0,
            net=sum(moves),
            trend_n=len(trend), trend_sum=sum(trend),
            expectancy=sum(moves) / len(moves),
        )
    up = stats([lg for lg in all_legs if lg[0] == "CE"])   # uptrend legs
    dn = stats([lg for lg in all_legs if lg[0] == "PE"])   # downtrend legs
    both = stats(all_legs)
    return dict(both=both, up=up, dn=dn, days=len(days), n=both["n"])


def main():
    # SLOPE (current, averaging) vs REVERSAL (peak/trough, no averaging).
    print(f"{'inst':10} {'mode':>16} {'legs':>5} {'win%':>6} {'adverse%':>8} "
          f"{'avgWin':>7} {'avgLos':>7} {'exp%':>7} {'up win%':>8} {'dn win%':>8}")
    for inst, fname in INSTS.items():
        rows = [("slope thr_hi=.015", dict(thr_hi=0.015, rev_pct=0.0))]
        for rv in (0.05, 0.08, 0.12, 0.18, 0.25):
            rows.append((f"reversal {rv:.2f}%", dict(thr_hi=0.015, rev_pct=rv)))
        for label, kw in rows:
            cfg = MASignalThresholds(enabled=True, ema_period=20, slope_lookback=10,
                                     thr_lo=0.006, **kw)
            r = run(cfg, fname)
            if not r.get("n"):
                continue
            b, up, dn = r["both"], r["up"], r["dn"]
            print(f"{inst:10} {label:>16} {b['n']:5d} {b['win_rate']:6.1f} "
                  f"{100 - b['win_rate']:8.1f} {b['avg_win']:7.2f} {b['avg_loss']:7.2f} "
                  f"{b['expectancy']:7.3f} {up['win_rate']:8.1f} {dn['win_rate']:8.1f}")
        print()


if __name__ == "__main__":
    main()
