"""
main.py — TickFeatureAgent (TFA) entry point.

Usage:

  Live mode (starts WebSocket feed + chain poller, emits features continuously):
    python python_modules/tick_feature_agent/main.py \\
        --instrument-profile config/instrument_profiles/nifty50_profile.json \\
        --mode live

  Replay mode (processes recorded data, writes Parquet):
    python python_modules/tick_feature_agent/main.py \\
        --instrument-profile config/instrument_profiles/nifty50_profile.json \\
        --mode replay \\
        --date 2026-04-10

  Replay range (iterate multiple dates):
    python python_modules/tick_feature_agent/main.py \\
        --instrument-profile config/instrument_profiles/nifty50_profile.json \\
        --mode replay \\
        --date-from 2026-04-01 --date-to 2026-04-14
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Force UTF-8 output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── Path setup ────────────────────────────────────────────────────────────────
_HERE           = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
_PROJECT_ROOT   = _PYTHON_MODULES.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

from tick_feature_agent.instrument_profile import load_profile, ProfileValidationError
from tick_feature_agent.log.tfa_logger import setup_logging, get_logger, shutdown_logging

# ── ANSI colour helpers ───────────────────────────────────────────────────────
_NO_COLOUR = os.environ.get("NO_COLOR") or not sys.stdout.isatty()

def _c(code: str, text: str) -> str:
    return text if _NO_COLOUR else f"\033[{code}m{text}\033[0m"

GREEN  = lambda t: _c("32", t)
YELLOW = lambda t: _c("33", t)
RED    = lambda t: _c("31", t)
CYAN   = lambda t: _c("36", t)
BOLD   = lambda t: _c("1",  t)
DIM    = lambda t: _c("2",  t)

TICK   = GREEN("✓")
CROSS  = RED("✗")
PEND   = YELLOW("○")

_IST = timezone(timedelta(hours=5, minutes=30))


# ── Console helpers ───────────────────────────────────────────────────────────

def _banner(instrument: str, mode: str) -> None:
    width = 60
    print()
    print("  " + BOLD("─" * width))
    print("  " + BOLD("  TickFeatureAgent (TFA)"))
    print(f"  {'':2}  Instrument : {CYAN(instrument)}")
    print(f"  {'':2}  Mode       : {CYAN(mode)}")
    print(f"  {'':2}  Started    : {datetime.now(_IST).strftime('%Y-%m-%d %H:%M:%S IST')}")
    print("  " + BOLD("─" * width))
    print()


def _step(symbol: str, label: str, detail: str = "") -> None:
    pad = 26
    label_fmt = f"  {symbol}  {label:<{pad}}"
    print(f"{label_fmt}  {detail}" if detail else label_fmt)


def _fatal(msg: str) -> None:
    print()
    print(f"  {RED('FATAL')}  {msg}")
    print()
    sys.exit(1)


# ── Credentials helper ────────────────────────────────────────────────────────

def _fetch_credentials(base_url: str) -> dict | None:
    try:
        import requests
    except ImportError:
        return None
    try:
        resp = requests.get(f"{base_url}/api/broker/token", timeout=5)
    except Exception as exc:
        return {"_error": str(exc)}
    if resp.status_code != 200:
        return {"_error": f"http_{resp.status_code}"}
    body = resp.json()
    if not body.get("success"):
        return {"_error": "api_error"}
    return body.get("data", {})


def _resolve_ws_security_id(base_url: str, profile) -> str:
    """
    Resolve the WebSocket security ID for the underlying futures contract.

    For NSE instruments (NIFTY, BANKNIFTY etc.):
      - Queries scrip master for the nearest FUTIDX expiry
      - Returns its security ID (e.g. "66691" for NIFTY-Apr2026-FUT)
    For MCX instruments:
      - Returns profile.underlying_security_id directly (already the futures ID)
    Falls back to profile.underlying_security_id on any error.
    """
    try:
        import requests as _req
    except ImportError:
        return profile.underlying_security_id

    if profile.exchange == "MCX":
        return profile.underlying_security_id

    # NSE: resolve near-month FUTIDX security ID from scrip master
    instrument_name_param = "FUTIDX"
    symbol = profile.instrument_name  # e.g. "NIFTY", "BANKNIFTY"
    try:
        # Step 1: get expiry list
        r = _req.get(
            f"{base_url}/api/broker/scrip-master/expiry-list",
            params={"symbol": symbol, "instrumentName": instrument_name_param},
            timeout=5,
        )
        if r.status_code != 200:
            return profile.underlying_security_id
        expiries = r.json().get("data", [])
        if not expiries:
            return profile.underlying_security_id

        from datetime import date as _date
        today = _date.today().isoformat()
        future = sorted(e for e in expiries if e >= today)
        if not future:
            return profile.underlying_security_id
        nearest_expiry = future[0]

        # Step 2: lookup security ID for that expiry
        r2 = _req.get(
            f"{base_url}/api/broker/scrip-master/lookup",
            params={"symbol": symbol, "instrumentName": instrument_name_param,
                    "expiry": nearest_expiry},
            timeout=5,
        )
        if r2.status_code != 200:
            return profile.underlying_security_id
        body = r2.json()
        if not body.get("success"):
            return profile.underlying_security_id
        sec_id = body["data"].get("securityId", "")
        return str(sec_id) if sec_id else profile.underlying_security_id
    except Exception:
        return profile.underlying_security_id


def _mask(value: str) -> str:
    if not value or len(value) <= 6:
        return "***"
    return value[:3] + "·" * 4 + value[-3:]


# ── Session boundary helper ───────────────────────────────────────────────────

def _session_boundary_sec(date_str: str, hhmm: str) -> float:
    h, m = hhmm.split(":")
    dt = datetime(
        int(date_str[:4]), int(date_str[5:7]), int(date_str[8:10]),
        int(h), int(m), tzinfo=_IST,
    )
    return dt.timestamp()


# ══════════════════════════════════════════════════════════════════════════════
# LIVE MODE
# ══════════════════════════════════════════════════════════════════════════════

async def _run_live(profile, args, log) -> None:
    """
    Full live pipeline:
      DhanFeed (WS) + ChainPoller (REST) → TickProcessor → Emitter + SessionRecorder
    """
    from tick_feature_agent.buffers.tick_buffer import CircularBuffer
    from tick_feature_agent.buffers.option_buffer import OptionBufferStore
    from tick_feature_agent.chain_cache import ChainCache
    from tick_feature_agent.state_machine import StateMachine
    from tick_feature_agent.session import SessionManager
    from tick_feature_agent.tick_processor import TickProcessor
    from tick_feature_agent.output.emitter import Emitter
    from tick_feature_agent.recorder.session_recorder import SessionRecorder
    from tick_feature_agent.feed.dhan_feed import DhanFeed
    from tick_feature_agent.feed.chain_poller import ChainPoller

    # ── Fetch credentials ─────────────────────────────────────────────────────
    creds = _fetch_credentials(args.broker_url)
    if not creds or "_error" in creds:
        err = (creds or {}).get("_error", "unknown")
        _fatal(f"Cannot fetch broker credentials: {err}\n"
               f"       Is the Node.js server running at {args.broker_url}?")

    access_token = creds.get("accessToken") or creds.get("access_token", "")
    client_id    = creds.get("clientId")    or creds.get("client_id",    "")
    if not access_token or not client_id:
        _fatal("Broker credentials missing accessToken or clientId")

    log.info("CREDENTIALS_OK", msg="Broker credentials fetched",
             client_id_masked=_mask(str(client_id)))

    # ── Instantiate pipeline components ───────────────────────────────────────
    tick_buf   = CircularBuffer(maxlen=50)
    opt_store  = OptionBufferStore()
    cache      = ChainCache()
    sm         = StateMachine(warm_up_duration_sec=profile.warm_up_duration_sec)
    emitter    = Emitter(
        file_path=args.output_file,
        socket_addr=_parse_socket(args.output_socket),
    )
    recorder   = SessionRecorder(
        instrument=profile.instrument_name.lower(),
        data_root=args.data_root,
        underlying_symbol=profile.underlying_symbol,
        underlying_security_id=profile.underlying_security_id,
        expiry="",   # set after chain_poller.startup()
        logger=log,
    )

    processor = TickProcessor(
        profile=profile,
        state_machine=sm,
        tick_buffer=tick_buf,
        option_store=opt_store,
        chain_cache=cache,
        emitter=emitter,
        recorder=recorder,
        logger=log,
    )

    # ── SessionManager callbacks ──────────────────────────────────────────────
    def _on_session_open():
        today = datetime.now(_IST).strftime("%Y-%m-%d")
        end_sec = _session_boundary_sec(today, profile.session_end)
        processor.on_session_open(session_end_sec=end_sec)
        recorder.on_session_open(today)
        log.info("SESSION_OPEN", msg=f"Session opened for {today}")

    def _on_session_close():
        processor.on_session_close()
        recorder.on_session_close()
        log.info("SESSION_CLOSE", msg="Session closed")

    def _on_rollover():
        if poller.active_expiry:
            recorder.on_expiry_rollover(
                new_expiry=poller.active_expiry,
                new_underlying_symbol=profile.underlying_symbol,
            )
        log.info("EXPIRY_ROLLOVER", msg=f"Rolled to {poller.active_expiry}")

    session_mgr = SessionManager(
        profile=profile,
        state_machine=sm,
        tick_buffer=tick_buf,
        option_buffer=opt_store,
        on_session_start=_on_session_open,
        on_session_end=_on_session_close,
        on_rollover=_on_rollover,
    )
    processor._session_mgr = session_mgr

    # ── Chain poller ──────────────────────────────────────────────────────────
    poller = ChainPoller(
        profile=profile,
        broker_url=args.broker_url,
        on_snapshot=processor.on_chain_snapshot,
        on_chain_stale=processor.on_chain_stale,
        on_chain_recovered=processor.on_chain_recovered,
        on_rollover=lambda new_expiry: recorder.on_expiry_rollover(
            new_expiry=new_expiry,
        ) if recorder._date else None,
        on_new_strikes=lambda new_sec_ids: feed.subscribe_options(new_sec_ids),
    )

    # ── Startup: resolve expiry + fetch first chain snapshot ─────────────────
    print(f"\n  {PEND}  Connecting to broker chain API …")
    try:
        first_snapshot = await poller.startup()
    except Exception as exc:
        _fatal(f"Chain poller startup failed: {exc}")

    recorder._expiry = first_snapshot.expiry
    log.info("CHAIN_STARTUP_OK",
             msg=f"First chain snapshot: expiry={first_snapshot.expiry}, "
                 f"spot={first_snapshot.spot_price}, "
                 f"strikes={len(first_snapshot.rows)}",
             expiry=first_snapshot.expiry)
    _step(TICK, "Chain poller startup",
          f"expiry={first_snapshot.expiry}  spot={first_snapshot.spot_price:.0f}  "
          f"strikes={len(first_snapshot.rows)}")

    # Load the first snapshot into cache now (chain poller will keep updating)
    processor.on_chain_snapshot(first_snapshot)

    # ── DhanFeed WebSocket ────────────────────────────────────────────────────
    # Resolve the near-month futures security ID for WebSocket subscription.
    # NSE profiles store the index ID (e.g. 13) for the REST chain API;
    # the WebSocket needs the tradeable futures contract ID instead.
    ws_security_id = _resolve_ws_security_id(args.broker_url, profile)
    log.info("WS_SECURITY_ID_RESOLVED",
             msg=f"WebSocket underlying security ID: {ws_security_id}",
             ws_security_id=ws_security_id,
             profile_security_id=profile.underlying_security_id)
    _step(TICK, "WS security ID resolved", ws_security_id)

    def _on_underlying_tick(data: dict) -> None:
        session_mgr.on_tick()   # fires session_start edge trigger
        processor.on_underlying_tick(data)

    feed = DhanFeed(
        access_token=str(access_token),
        client_id=str(client_id),
        exchange=profile.exchange,
        underlying_security_id=ws_security_id,
        on_underlying_tick=_on_underlying_tick,
        on_option_tick=processor.on_option_tick,
        on_connected=lambda: log.info("FEED_CONNECTED", msg="WebSocket connected"),
        on_disconnected=lambda: (
            sm.on_feed_disconnect(),
            log.warn("FEED_DISCONNECTED", msg="WebSocket disconnected"),
        ),
    )

    # Subscribe underlying futures
    feed.subscribe_underlying()

    # Subscribe all options from first snapshot
    feed.subscribe_options(first_snapshot.sec_id_map)

    _step(TICK, "WebSocket subscribed",
          f"underlying={profile.underlying_security_id}  "
          f"options={len(first_snapshot.sec_id_map)}")

    # ── Periodic tasks ────────────────────────────────────────────────────────
    async def _stale_checker():
        """Check for feed staleness every 2 seconds."""
        while True:
            await asyncio.sleep(2)
            processor.check_feed_stale()

    # ── Run ───────────────────────────────────────────────────────────────────
    print()
    print(f"  {GREEN('● RUNNING')}  Press Ctrl+C to stop.")
    print()

    try:
        await asyncio.gather(
            feed.run(),
            poller.run(),
            _stale_checker(),
        )
    except asyncio.CancelledError:
        pass
    finally:
        processor.on_session_close()   # flush pending target rows
        recorder.on_session_close()    # flush + close gzip writers properly
        emitter.close()
        log.info("TFA_STOPPED", msg="TFA stopped cleanly")


def _parse_socket(addr: str | None):
    if not addr:
        return None
    try:
        host, port = addr.rsplit(":", 1)
        return (host, int(port))
    except ValueError:
        return None


# ══════════════════════════════════════════════════════════════════════════════
# REPLAY MODE
# ══════════════════════════════════════════════════════════════════════════════

def _run_replay(profile, args, log) -> None:
    """Run replay for a single date or a date range."""
    from tick_feature_agent.replay.replay_runner import replay

    if args.date:
        date_from = date_to = args.date
    elif args.date_from and args.date_to:
        date_from, date_to = args.date_from, args.date_to
    else:
        _fatal("Replay mode requires --date or both --date-from and --date-to")

    summary = replay(
        profile_path=Path(args.instrument_profile),
        instrument=profile.instrument_name.lower(),
        date_from=date_from,
        date_to=date_to,
        raw_root=args.data_root,
        features_root=args.features_root,
        validation_root=args.validation_root,
        logger=log,
    )

    print()
    print(f"  Replay complete  ({date_from} → {date_to})")
    print(f"  PASS: {summary.get('pass', 0)}  "
          f"WARN: {summary.get('warn', 0)}  "
          f"FAIL: {summary.get('fail', 0)}  "
          f"SKIP: {summary.get('skip', 0)}")
    print()

    if summary.get("fail", 0):
        sys.exit(1)


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="tfa",
        description="TickFeatureAgent — real-time option chain feature engine",
    )
    parser.add_argument(
        "--instrument-profile", required=True, metavar="PATH",
        help="Path to instrument profile JSON",
    )
    parser.add_argument(
        "--mode", choices=["live", "replay"], default="live",
        help="Operating mode (default: live)",
    )
    # Single-date replay
    parser.add_argument(
        "--date", metavar="YYYY-MM-DD",
        help="Replay date (single date)",
    )
    # Date-range replay
    parser.add_argument("--date-from", metavar="YYYY-MM-DD", help="Replay start date")
    parser.add_argument("--date-to",   metavar="YYYY-MM-DD", help="Replay end date")
    # Output
    parser.add_argument("--output-file",   metavar="PATH",     default=None)
    parser.add_argument("--output-socket", metavar="HOST:PORT", default=None)
    # Paths
    parser.add_argument("--broker-url",      default="http://localhost:3000")
    parser.add_argument("--data-root",       default="data/raw")
    parser.add_argument("--features-root",   default="data/features")
    parser.add_argument("--validation-root", default="data/validation")
    # Logging
    parser.add_argument("--log-dir",   default="logs",  metavar="DIR")
    parser.add_argument("--log-level", choices=["DEBUG", "INFO", "WARN", "ERROR"],
                        default="INFO")

    args = parser.parse_args()

    # Validate replay args
    if args.mode == "replay":
        if not args.date and not (args.date_from and args.date_to):
            parser.error(
                "Replay mode requires --date  OR  --date-from + --date-to"
            )

    # ── Load profile ──────────────────────────────────────────────────────────
    profile_path = Path(args.instrument_profile)
    if not profile_path.is_absolute():
        profile_path = Path.cwd() / profile_path

    try:
        profile = load_profile(profile_path)
    except FileNotFoundError:
        print(f"\n  {CROSS}  Instrument profile not found: {profile_path}\n",
              file=sys.stderr)
        sys.exit(1)
    except ProfileValidationError as exc:
        print(f"\n  {CROSS}  Profile validation failed: {exc}\n", file=sys.stderr)
        sys.exit(1)

    # ── Logging ───────────────────────────────────────────────────────────────
    _level_map = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40}
    setup_logging(
        profile.instrument_name,
        log_dir=str(Path.cwd() / args.log_dir),
        level=_level_map.get(args.log_level, 20),
    )
    log = get_logger("tfa.main", instrument=profile.instrument_name)

    # ── Banner ────────────────────────────────────────────────────────────────
    if args.mode == "live":
        mode_str = "live"
    elif args.date:
        mode_str = f"replay  {args.date}"
    else:
        mode_str = f"replay  {args.date_from} → {args.date_to}"

    _banner(f"{profile.instrument_name}  ({profile.exchange})", mode_str)

    log.info("TFA_START", msg=f"TFA starting — {profile.instrument_name} {args.mode}",
             instrument=profile.instrument_name, exchange=profile.exchange,
             mode=args.mode)

    # ── Dispatch ──────────────────────────────────────────────────────────────
    try:
        if args.mode == "live":
            asyncio.run(_run_live(profile, args, log))
        else:
            _run_replay(profile, args, log)
    except KeyboardInterrupt:
        print(f"\n  {YELLOW('Interrupted')}  — stopping TFA.\n")
        log.info("TFA_INTERRUPTED", msg="KeyboardInterrupt — stopped")
    finally:
        shutdown_logging()


if __name__ == "__main__":
    main()
