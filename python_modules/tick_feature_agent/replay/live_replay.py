"""
Live-mode tick replay — drives SEA off recorded ticks.

Feeds a day's RECORDED ticks (data/raw/<date>/<inst>_*.ndjson.gz) through the
LIVE feature pipeline (TickProcessor → Emitter) at recorded pace, so a SEA
started with `--max-row-age 0` fires signals off the replayed feature stream —
a live-equivalent dry run of the whole flow.

It reuses the same components as main._run_live and the recorded→object
converters from replay_adapter; it NEVER touches TFA's live Dhan WebSocket
(no DhanFeed, no ChainPoller, no credentials).

Run (per instrument):
  python -m tick_feature_agent.replay.live_replay \
      --instrument-profile config/instrument_profiles/nifty50_profile.json \
      --date 2026-07-17 --speed 1
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path


def run(instrument_profile: str, date: str, speed: float, data_root: str,
        output_file: str | None, output_socket: str | None) -> None:
    from tick_feature_agent.instrument_profile import load_profile
    from tick_feature_agent.buffers.option_buffer import OptionBufferStore
    from tick_feature_agent.buffers.tick_buffer import CircularBuffer
    from tick_feature_agent.chain_cache import ChainCache
    from tick_feature_agent.output.emitter import Emitter
    from tick_feature_agent.state_machine import StateMachine
    from tick_feature_agent.tick_processor import TickProcessor
    from tick_feature_agent.replay.stream_merger import merge_streams
    from tick_feature_agent.replay.replay_adapter import _build_chain_snapshot
    from tick_feature_agent.log.tfa_logger import get_logger
    from market_calendar import effective_session_end_epoch

    profile = load_profile(Path(instrument_profile))
    inst_key = Path(instrument_profile).stem.replace("_profile", "")
    out_file = output_file or f"{data_root}/features/{inst_key}_live.ndjson"
    log = get_logger("tfa.replay", instrument=profile.instrument_name)

    # ── Pipeline components (mirror main._run_live, live emit; no recorder) ──
    tick_buf = CircularBuffer(maxlen=50)
    opt_store = OptionBufferStore()
    cache = ChainCache()
    sm = StateMachine(warm_up_duration_sec=profile.warm_up_duration_sec)
    emitter = Emitter(
        file_path=out_file,
        socket_addr=output_socket,
        target_windows_sec=profile.target_windows_sec,
    )
    processor = TickProcessor(
        profile=profile,
        state_machine=sm,
        tick_buffer=tick_buf,
        option_store=opt_store,
        chain_cache=cache,
        emitter=emitter,
        recorder=None,
        logger=log,
    )
    # is_market_open: the live processor reads this from a SessionManager whose
    # is_market_open is a WALL-CLOCK check (session_start..session_end IST). During
    # replay the wall clock is outside market hours, so it returns 0 for EVERY row —
    # and the SEA/model preprocessor DROPS any row with is_market_open != 1
    # (model_training_agent/preprocessor.py), silently killing the whole feed. We
    # open the session manually below (on_session_open, anchored to the RECORDED
    # date), so every replayed tick is genuinely in-session; leaving _session_mgr as
    # None makes the processor default is_market_open to True (tick_processor.py:465).
    processor._session_mgr = None

    # Open the session manually for the RECORDED date (bypass the wall-clock
    # SessionManager gate, which would say "closed" for a past date).
    end_sec = effective_session_end_epoch(
        date, exchange=profile.exchange, default_hhmm=profile.session_end,
    )
    processor.on_session_open(session_end_sec=end_sec)

    date_folder = Path(f"{data_root}/raw/{date}")
    print(f"[replay] {inst_key} {date} @ {speed}x  -> {out_file}", flush=True)

    t0_recv: float | None = None
    t0_wall = time.time()
    n = {"u": 0, "o": 0, "c": 0, "v": 0}
    last_log = t0_wall

    for ev in merge_streams(date_folder, inst_key):
        data = ev.get("data") or {}
        recv = data.get("recv_ts")
        if not isinstance(recv, (int, float)):
            continue
        if t0_recv is None:
            t0_recv = float(recv)
        # Pace: this event fires at t0_wall + elapsed/speed.
        target = t0_wall + (float(recv) - t0_recv) / speed
        wait = target - time.time()
        if wait > 0.003:
            time.sleep(wait)

        etype = ev.get("type")
        try:
            if etype == "underlying_tick":
                processor.on_underlying_tick(data); n["u"] += 1
            elif etype == "option_tick":
                strike = data.get("strike")
                opt_type = data.get("opt_type") or data.get("option_type")
                if strike is not None and opt_type:
                    processor.on_option_tick(int(strike), str(opt_type), data); n["o"] += 1
            elif etype == "chain_snapshot":
                snap = _build_chain_snapshot(data)
                if snap is not None:
                    processor.on_chain_snapshot(snap); n["c"] += 1
            elif etype == "vix_tick":
                processor.on_vix_tick(data); n["v"] += 1
        except Exception as exc:  # keep the replay flowing; log + continue
            log.warn("REPLAY_DISPATCH_ERR", msg=str(exc), etype=str(etype))

        now = time.time()
        if now - last_log >= 5:
            last_log = now
            print(f"[replay] u={n['u']} o={n['o']} chain={n['c']} vix={n['v']}", flush=True)

    processor.on_session_close()
    print(f"[replay] DONE {inst_key} {date} — u={n['u']} o={n['o']} chain={n['c']} vix={n['v']}", flush=True)


def main() -> None:
    p = argparse.ArgumentParser(description="TFA live-mode tick replay (drives SEA off recorded ticks)")
    p.add_argument("--instrument-profile", required=True)
    p.add_argument("--date", required=True, help="YYYY-MM-DD (folder under data/raw)")
    p.add_argument("--data-root", default="data")
    p.add_argument("--output-file", default=None, help="feature ndjson (default data/features/<inst>_live.ndjson)")
    p.add_argument("--output-socket", default=None, help="host:port SEA listens on (optional)")
    p.add_argument("--speed", type=float, default=1.0)
    args = p.parse_args()
    run(args.instrument_profile, args.date, args.speed, args.data_root,
        args.output_file, args.output_socket)


if __name__ == "__main__":
    main()
