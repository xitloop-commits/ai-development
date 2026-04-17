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
import json
import os
import sys
import time
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
# On Windows, explicitly enable VT (ANSI) processing so cursor-movement codes
# work in cmd.exe / PowerShell even when isatty() reports False.
if sys.platform == "win32":
    try:
        import ctypes as _ctypes
        _k32 = _ctypes.windll.kernel32
        _STDOUT_HANDLE = _k32.GetStdHandle(-11)
        _mode = _ctypes.c_ulong()
        _k32.GetConsoleMode(_STDOUT_HANDLE, _ctypes.byref(_mode))
        _k32.SetConsoleMode(_STDOUT_HANDLE, _mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
    except Exception:
        pass

_NO_COLOUR = bool(os.environ.get("NO_COLOR"))
_NO_CURSOR = not sys.stdout.isatty()                   # piped/redirected — no in-place refresh

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


def _ensure_scrip_master(base_url: str, log) -> bool:
    """
    Ensure scrip master is loaded in BSA. Triggers a refresh if not loaded.
    Returns True if loaded after the call, False on any error.
    """
    try:
        import requests as _req
        r = _req.get(f"{base_url}/api/broker/scrip-master/status", timeout=5)
        if r.status_code == 200 and r.json().get("data", {}).get("isLoaded"):
            return True
        # Not loaded — trigger a full refresh (BSA fetches ~250k scrips from Dhan)
        log.info("SCRIP_MASTER_REFRESH", msg="Scrip master not loaded — triggering refresh")
        r2 = _req.post(f"{base_url}/api/broker/scrip-master/refresh", timeout=60)
        if r2.status_code == 200:
            log.info("SCRIP_MASTER_REFRESH_OK", msg="Scrip master refresh complete")
            return True
        log.warn("SCRIP_MASTER_REFRESH_FAIL",
                 msg=f"Scrip master refresh failed: http_{r2.status_code}")
        return False
    except Exception as exc:
        log.warn("SCRIP_MASTER_REFRESH_FAIL", msg=f"Scrip master check error: {exc}")
        return False


def _resolve_near_month_contract(base_url: str, profile) -> tuple[str, str]:
    """
    Resolve (ws_security_id, underlying_symbol) for the near-month futures contract.

    NSE instruments (NIFTY, BANKNIFTY):
      - Queries scrip master for nearest FUTIDX expiry
      - Returns (futures_security_id, e.g. "66691") and symbol (e.g. "NIFTY25APRFUT")
    MCX instruments (CRUDEOIL, NATURALGAS):
      - Queries scrip master for nearest FUTCOM expiry
      - Same structure, different instrument type

    Falls back to (profile.ws_security_id or profile.underlying_security_id,
                   profile.underlying_symbol) on any error.
    """
    fallback_id  = profile.ws_security_id or profile.underlying_security_id
    fallback_sym = profile.underlying_symbol
    instrument_type = "FUTCOM" if profile.exchange == "MCX" else "FUTIDX"
    symbol = profile.instrument_name  # "NIFTY", "BANKNIFTY", "CRUDEOIL", ...

    try:
        import requests as _req
        from datetime import date as _date

        r = _req.get(
            f"{base_url}/api/broker/scrip-master/expiry-list",
            params={"symbol": symbol, "instrumentName": instrument_type},
            timeout=5,
        )
        if r.status_code != 200:
            return fallback_id, fallback_sym

        expiries = r.json().get("data", [])
        today = _date.today().isoformat()
        future = sorted(e for e in expiries if e >= today)
        if not future:
            return fallback_id, fallback_sym

        r2 = _req.get(
            f"{base_url}/api/broker/scrip-master/lookup",
            params={"symbol": symbol, "instrumentName": instrument_type,
                    "expiry": future[0]},
            timeout=5,
        )
        if r2.status_code != 200:
            return fallback_id, fallback_sym

        body = r2.json()
        if not body.get("success"):
            return fallback_id, fallback_sym

        data  = body.get("data", {})
        sec_id = str(data.get("securityId", "")).strip()
        symbol_str = str(data.get("tradingSymbol", "")).strip()
        if not sec_id:
            return fallback_id, fallback_sym

        return sec_id, symbol_str or fallback_sym
    except Exception:
        return fallback_id, fallback_sym


def _fetch_holiday_status(base_url: str, exchange: str) -> dict:
    """
    Fetch today's holiday status for NSE or MCX via tRPC.
    Returns dict with keys: isHoliday (bool), holiday (MarketHoliday | None).
    Returns {} on any error.
    """
    try:
        import requests as _req
        input_param = json.dumps({"json": {"exchange": exchange}})
        r = _req.get(
            f"{base_url}/api/trpc/holidays.todayStatus",
            params={"input": input_param},
            timeout=5,
        )
        if r.status_code != 200:
            return {}
        body = r.json()
        # tRPC v10: {"result": {"data": {"json": {...}}}}
        result = body.get("result", {}).get("data", {})
        return result.get("json", result)
    except Exception:
        return {}


def _mask(value: str) -> str:
    if not value or len(value) <= 6:
        return "***"
    return value[:3] + "·" * 4 + value[-3:]


def _wait_for_server(base_url: str, log, timeout_sec: int = 120) -> None:
    """
    Poll <base_url>/health until it returns HTTP 200.
    Prints a waiting message and retries every 2 seconds.
    Exits with a fatal error if the server is not ready within timeout_sec.
    """
    try:
        import requests as _req
    except ImportError:
        return   # requests not available — skip check, fail later at credential fetch

    health_url = f"{base_url}/health"
    deadline = time.monotonic() + timeout_sec

    # First: check if already up (no message if instant)
    try:
        r = _req.get(health_url, timeout=2)
        if r.status_code == 200:
            return
    except Exception:
        pass

    # Server not yet up — show waiting message
    print(f"\n  {YELLOW('◌')}  Waiting for API server at {health_url} …", flush=True)
    attempt = 0
    while time.monotonic() < deadline:
        time.sleep(2)
        attempt += 1
        try:
            r = _req.get(health_url, timeout=2)
            if r.status_code == 200:
                _step(TICK, "API server ready", f"(after {attempt * 2}s)")
                log.info("SERVER_READY", msg=f"API server responded at {health_url}")
                return
        except Exception:
            pass
        if attempt % 5 == 0:
            remaining = int(deadline - time.monotonic())
            print(f"  {YELLOW('◌')}  Still waiting … ({remaining}s left)", flush=True)

    _fatal(
        f"API server did not become ready within {timeout_sec}s.\n"
        f"       Start the server first:  startup\\start-api.bat\n"
        f"       Expected:  {health_url}"
    )


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

async def _run_live(profile, args, log, _kb: dict) -> None:
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

    # ── Wait until 5 minutes before market open ─────────────────────────────
    # Don't hold a Dhan WebSocket for hours pre-market — connect just before
    # session start so the connection is fresh and avoids idle-timeout stalls.
    PRE_MARKET_LEAD_MIN = 5
    now_ist = datetime.now(_IST)
    today_str = now_ist.strftime("%Y-%m-%d")
    start_sec = _session_boundary_sec(today_str, profile.session_start)
    connect_at_sec = start_sec - PRE_MARKET_LEAD_MIN * 60

    if now_ist.timestamp() < connect_at_sec:
        wait_sec = connect_at_sec - now_ist.timestamp()
        h, m = profile.session_start.split(":")
        connect_time = f"{int(h):02d}:{int(m) - PRE_MARKET_LEAD_MIN:02d}" \
            if int(m) >= PRE_MARKET_LEAD_MIN \
            else f"{int(h) - 1:02d}:{int(m) + 60 - PRE_MARKET_LEAD_MIN:02d}"
        print(
            f"\n  {YELLOW('◌')}  Market opens at {profile.session_start} IST."
            f"  Connecting at {connect_time} IST ({int(wait_sec // 60)}m away).\n",
            flush=True,
        )
        log.info("PRE_MARKET_WAIT",
                 msg=f"Waiting {int(wait_sec)}s until {connect_time} IST "
                     f"({PRE_MARKET_LEAD_MIN}m before session_start)")
        # Sleep in 30s chunks so Ctrl+C / Esc menu still works
        while time.time() < connect_at_sec:
            time.sleep(min(30, max(0, connect_at_sec - time.time())))

    # ── Wait for API server ───────────────────────────────────────────────────
    _wait_for_server(args.broker_url, log)

    # ── Fetch credentials (retry for up to 30s — server may lag after /health) ──
    creds = None
    _cred_deadline = time.monotonic() + 30
    _cred_attempt  = 0
    while True:
        creds = _fetch_credentials(args.broker_url)
        if creds and "_error" not in creds:
            break
        _cred_attempt += 1
        if time.monotonic() >= _cred_deadline:
            err = (creds or {}).get("_error", "unknown")
            _fatal(f"Cannot fetch broker credentials after retries: {err}\n"
                   f"       Is the Node.js server running at {args.broker_url}?")
        if _cred_attempt == 1:
            print(f"  {YELLOW('◌')}  Waiting for broker credentials …", flush=True)
        time.sleep(2)

    access_token = creds.get("accessToken") or creds.get("access_token", "")
    client_id    = creds.get("clientId")    or creds.get("client_id",    "")
    if not access_token or not client_id:
        _fatal("Broker credentials missing accessToken or clientId")

    log.info("CREDENTIALS_OK", msg="Broker credentials fetched",
             client_id_masked=_mask(str(client_id)))

    # ── Scrip master + near-month contract resolution ─────────────────────────
    print(f"  {PEND}  Resolving near-month contract …")
    _ensure_scrip_master(args.broker_url, log)
    ws_security_id, underlying_symbol = _resolve_near_month_contract(args.broker_url, profile)
    log.info("CONTRACT_RESOLVED",
             msg=f"Near-month contract: {underlying_symbol}  id={ws_security_id}",
             ws_security_id=ws_security_id, underlying_symbol=underlying_symbol)
    _step(TICK, "Near-month contract", f"{underlying_symbol}  (id={ws_security_id})")

    # ── Holiday status (fetch both exchanges up-front) ────────────────────────
    _holiday_nse = _fetch_holiday_status(args.broker_url, "NSE")
    _holiday_mcx = _fetch_holiday_status(args.broker_url, "MCX")

    # ── Derive instrument key from profile filename ───────────────────────────
    # We use the profile FILENAME (e.g. "nifty50") not instrument_name
    # lowercased ("nifty"). This keeps raw filenames consistent with the rest
    # of the system (bat scripts, live ndjson, parquet, models directory).
    # Pre-2026-04-17 the recorder used instrument_name.lower() which wrote
    # nifty_*.ndjson.gz — creating a mismatch with the nifty50 key everywhere
    # else and breaking replay.
    profile_path_live = Path(args.instrument_profile)
    instrument_key = profile_path_live.stem.replace("_profile", "")

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
        instrument=instrument_key,
        data_root=args.data_root,
        underlying_symbol=underlying_symbol,       # resolved, not profile default
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
        # Known bug (pre-2026-04-17): chain_poller._check_rollover marks
        # _rolled_over=True but never updates _active_expiry to the new
        # contract. Underlying WebSocket keeps subscribing to expired
        # security_id, chain poller keeps querying expired expiry.
        #
        # Simple fix: exit with code 75 so the bat loop restarts TFA.
        # Fresh startup re-runs _resolve_near_month_contract() which picks
        # the NEXT FUTIDX/FUTCOM expiry > today — effectively rolling to
        # the new contract with correct security_id + chain + strikes.
        if poller.active_expiry:
            recorder.on_expiry_rollover(
                new_expiry=poller.active_expiry,
                new_underlying_symbol=underlying_symbol,
            )
        log.warn(
            "EXPIRY_ROLLOVER_EXIT",
            msg=f"Expiry rollover on {poller.active_expiry} — exiting with code 75 "
                f"so bat loop restarts TFA on the next contract.",
            old_expiry=poller.active_expiry,
        )
        print(
            f"\n  {YELLOW('◼  Expiry rollover')} — restarting on next contract…\n",
            flush=True,
        )
        try:
            processor.on_session_close()
            recorder.on_session_close()
        except Exception:
            pass
        sys.exit(75)

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

    # ── Health tracking state ─────────────────────────────────────────────────
    _h: dict = {
        "feed_ok": False,
        "session_open": False,
        "session_ts": None,
        "u_ticks": 0,
        "o_ticks": 0,
        "chain_snaps": 0,        # incremented AFTER startup snapshot
        "last_u_ts": None,
        "last_chain_ts": None,
        "u_ticks_prev": 0,
        "u_rate": 0.0,
        "holiday_nse": _holiday_nse,   # pre-fetched at startup
        "holiday_mcx": _holiday_mcx,
        "disconnect_code": None,
        "disconnect_reason": None,
        "retry_at": None,
        "retry_attempt": 0,
    }
    _HEALTH_INTERVAL = 3.0
    _health_nlines: list[int] = [0]   # mutable cell for closure

    def _on_underlying_tick(data: dict) -> None:
        _h["u_ticks"] += 1
        _h["last_u_ts"] = time.monotonic()
        _h["feed_ok"] = True
        session_mgr.on_tick()   # fires session_start edge trigger
        processor.on_underlying_tick(data)

    def _on_option_tick(strike: int, opt_type: str, data: dict) -> None:
        _h["o_ticks"] += 1
        processor.on_option_tick(strike, opt_type, data)

    def _on_chain_snapshot(snap) -> None:
        _h["chain_snaps"] += 1
        _h["last_chain_ts"] = time.monotonic()
        processor.on_chain_snapshot(snap)

    # Wrap session open/close to update health
    _orig_session_open  = _on_session_open   # noqa: F821 — defined above
    _orig_session_close = _on_session_close  # noqa: F821 — defined above

    def _on_session_open_h():
        _h["session_open"] = True
        _h["session_ts"] = time.monotonic()
        _orig_session_open()

    def _on_session_close_h():
        _h["session_open"] = False
        _orig_session_close()
        # Market closed — schedule a clean exit after a short flush delay
        print(f"\n  {YELLOW('◼  Market session closed.')}  Stopping in 10s…\n", flush=True)
        log.info("SESSION_AUTO_STOP", msg="Market session closed — TFA will stop in 10s")
        asyncio.ensure_future(_auto_stop())

    # Rebuild session_mgr with wrapped callbacks (replace in-place)
    session_mgr._on_session_start = _on_session_open_h
    session_mgr._on_session_end   = _on_session_close_h

    feed = DhanFeed(
        access_token=str(access_token),
        client_id=str(client_id),
        exchange=profile.exchange,
        underlying_security_id=ws_security_id,
        on_underlying_tick=_on_underlying_tick,
        on_option_tick=_on_option_tick,
        on_connected=lambda: (
            _h.__setitem__("feed_ok", True),
            _h.__setitem__("disconnect_code", None),
            _h.__setitem__("disconnect_reason", None),
            _h.__setitem__("retry_at", None),
            _h.__setitem__("retry_attempt", 0),
            log.info("FEED_CONNECTED", msg="WebSocket connected"),
        ),
        on_disconnected=lambda: (
            _h.__setitem__("feed_ok", False),
            sm.on_feed_disconnect(),
            log.warn("FEED_DISCONNECTED", msg="WebSocket disconnected"),
        ),
        on_disconnect_code=lambda code, reason: (
            _h.__setitem__("disconnect_code", code),
            _h.__setitem__("disconnect_reason", reason),
            log.error("DHAN_DISCONNECT", msg=f"Dhan server disconnect: {reason}", code=code),
        ),
        on_reconnecting=lambda retry_at, attempt: (
            _h.__setitem__("retry_at", retry_at),
            _h.__setitem__("retry_attempt", attempt),
        ),
        credential_fetcher=lambda: _fetch_credentials(args.broker_url),
    )

    # Subscribe underlying futures
    feed.subscribe_underlying()

    # Subscribe all options from first snapshot — use wrapped chain snapshot callback
    # for the poller's subsequent snapshots
    feed.subscribe_options(first_snapshot.sec_id_map)

    _step(TICK, "WebSocket subscribed",
          f"underlying={ws_security_id}  "
          f"options={len(first_snapshot.sec_id_map)}")

    # Rewire poller to use wrapped snapshot callback
    poller._on_snapshot = _on_chain_snapshot

    # ── Periodic tasks ────────────────────────────────────────────────────────
    async def _stale_checker():
        """Check for feed staleness every 2 seconds."""
        while True:
            await asyncio.sleep(2)
            processor.check_feed_stale()

    async def _recorder_flusher():
        """Flush gzip writers to disk every 3 seconds so file sizes grow visibly."""
        while True:
            await asyncio.sleep(3)
            recorder.flush()

    async def _tick_watchdog():
        """
        Detect silent tick-stall: session is OPEN but no underlying tick
        for > TICK_STALL_THRESHOLD_SEC. Typical cause is Dhan-side socket
        that stays 'connected' but stops sending frames (what happened
        2026-04-16 17:15 IST — both MCX feeds silently stopped for 6h).
        On stall: log ERROR, terminate with exit code 75 so the bat
        loop relaunches the process cleanly.
        """
        TICK_STALL_THRESHOLD_SEC = 120   # 2 minutes with no tick in open session
        CHECK_INTERVAL_SEC       = 30
        # Grace period after session open so we don't false-fire on slow first tick
        GRACE_AFTER_SESSION_OPEN = 60

        while True:
            await asyncio.sleep(CHECK_INTERVAL_SEC)

            if not _h.get("session_open"):
                continue

            session_ts = _h.get("session_ts")
            if session_ts is None:
                continue
            now = time.monotonic()
            if now - session_ts < GRACE_AFTER_SESSION_OPEN:
                continue   # grace window — let the feed warm up

            last_u_ts = _h.get("last_u_ts")
            # No tick ever received since session open
            if last_u_ts is None:
                age = now - session_ts
            else:
                age = now - last_u_ts

            if age > TICK_STALL_THRESHOLD_SEC:
                log.error(
                    "FEED_WATCHDOG_STALL",
                    msg=f"No underlying ticks for {age:.0f}s while session open — "
                        f"exiting with code 75 so bat loop restarts the process.",
                    tick_age_sec=round(age, 1),
                    threshold_sec=TICK_STALL_THRESHOLD_SEC,
                )
                print(
                    f"\n  {RED('FEED STALLED')}  no ticks for {age:.0f}s — "
                    f"auto-restarting...\n",
                    flush=True,
                )
                # Close writers + log cleanly, then exit 75 (bat loop picks up)
                try:
                    recorder.on_session_close()
                except Exception:
                    pass
                sys.exit(75)

    def _render_health() -> list[str]:
        """Build health display lines (no trailing newline on each)."""
        now = time.monotonic()
        ts  = datetime.now(_IST).strftime("%H:%M:%S")

        # Feed
        if _h["feed_ok"]:
            if _h["last_u_ts"] is not None:
                age = now - _h["last_u_ts"]
                if age < 5:
                    feed_s = GREEN("● OK") + f"  (tick {age:.1f}s ago)"
                elif age < 30:
                    feed_s = YELLOW("● SLOW") + f"  ({age:.0f}s ago)"
                else:
                    feed_s = RED("● STALE") + f"  ({age:.0f}s ago)"
            else:
                feed_s = YELLOW("● CONNECTED") + "  (no ticks yet)"
        else:
            if _h.get("retry_at"):
                secs_left = max(0.0, _h["retry_at"] - time.time())
                feed_s = (RED("✗ DISCONNECTED") +
                          f"  retry in {secs_left:.0f}s"
                          f"  (attempt {_h['retry_attempt']})")
            else:
                feed_s = RED("✗ DISCONNECTED")

        # Session
        if _h["session_open"]:
            if _h["session_ts"] is not None:
                secs = int(now - _h["session_ts"])
                elapsed = f"{secs // 3600:02d}:{(secs % 3600) // 60:02d}:{secs % 60:02d}"
            else:
                elapsed = ""
            sess_s = GREEN("● OPEN") + f"  {elapsed}"
        else:
            sess_s = YELLOW("○ WAITING")

        # Ticks
        rate_s = f"  ({_h['u_rate']:.1f}/s)" if _h["u_rate"] > 0.05 else ""

        # Chain
        if _h["last_chain_ts"] is not None:
            cage = now - _h["last_chain_ts"]
            chain_s = f"{_h['chain_snaps']} snaps  (last {cage:.0f}s ago)"
        else:
            chain_s = f"{_h['chain_snaps']} snaps"

        # Holiday status lines — one per exchange if holiday today
        holiday_lines: list[str] = []
        for exch, key in (("NSE", "holiday_nse"), ("MCX", "holiday_mcx")):
            hdata = _h.get(key, {})
            if hdata.get("isHoliday"):
                hol   = hdata.get("holiday") or {}
                name  = hol.get("description", "Holiday")
                # For MCX show session detail if available
                m_ses = hol.get("morningSession", "")
                e_ses = hol.get("eveningSession", "")
                if m_ses or e_ses:
                    ses_detail = f"  (morning {m_ses} · evening {e_ses})"
                else:
                    ses_detail = ""
                holiday_lines.append(
                    f"  {RED('⚑')} {exch} holiday : {YELLOW(name)}{DIM(ses_detail)}"
                )

        W = 56
        lines = [
            f"  {DIM('─' * W)}",
            f"  {DIM('Health')}  {BOLD(ts)}",
            f"  Feed    : {feed_s}",
            f"  Session : {sess_s}",
            f"  Ticks   : {_h['u_ticks']:>9,} underlying{rate_s}",
            f"  Options : {_h['o_ticks']:>9,} ticks",
            f"  Chain   : {chain_s}",
        ]
        lines.extend(holiday_lines)

        # Dhan disconnect reason — shown until next successful connect
        if not _h["feed_ok"] and _h.get("disconnect_reason"):
            lines.append(
                f"  {RED('✗ Dhan:')}  code={_h['disconnect_code']}  "
                f"{RED(_h['disconnect_reason'])}"
            )

        lines.append(f"  {DIM('─' * W)}")

        # Esc menu overlay
        if _kb.get("menu"):
            lines.append(f"  {YELLOW('⏸  Paused')}  —  choose an action:")
            lines.append(f"  {BOLD('Enter')} Restart   "
                         f"{BOLD('Esc')} Exit   "
                         f"{BOLD('C')} Continue")
            lines.append(f"  {DIM('─' * W)}")

        return lines

    async def _health_display():
        """Refresh the health block in-place every 3 seconds."""
        # Initial print — just paint the block for the first time
        lines = _render_health()
        for ln in lines:
            print(ln)
        _health_nlines[0] = len(lines)

        while True:
            await asyncio.sleep(_HEALTH_INTERVAL)

            # Compute tick rate over the last interval
            delta = _h["u_ticks"] - _h["u_ticks_prev"]
            _h["u_rate"] = delta / _HEALTH_INTERVAL
            _h["u_ticks_prev"] = _h["u_ticks"]

            lines = _render_health()
            if not _NO_CURSOR and _health_nlines[0] > 0:
                # Move cursor to start of previous block and overwrite line-by-line
                sys.stdout.write(f"\033[{_health_nlines[0]}F")
                for ln in lines:
                    sys.stdout.write(f"\033[2K{ln}\n")
            else:
                # No cursor movement — print separator so repeated blocks are readable
                print()
                for ln in lines:
                    print(ln)
            sys.stdout.flush()
            _health_nlines[0] = len(lines)

    # ── Keyboard handler (Esc menu) ───────────────────────────────────────────
    async def _keyboard_handler():
        """
        Windows-only: watch for Esc key to show the pause menu while TFA runs.
        Non-Windows: no-op (use Ctrl+C to stop).
        """
        if sys.platform != "win32":
            return
        import msvcrt as _msvcrt
        while True:
            await asyncio.sleep(0.05)
            if not _msvcrt.kbhit():
                continue
            ch = _msvcrt.getwch()
            if ch != "\x1b":          # ignore non-Esc keys
                continue
            # \x1b could be an ANSI escape sequence from terminal output.
            # A real Esc keypress is a lone \x1b — drain any following chars.
            await asyncio.sleep(0.02)
            while _msvcrt.kbhit():
                _msvcrt.getwch()
            if _msvcrt.kbhit():       # still more chars → ANSI sequence, ignore
                continue
            # Confirmed lone Esc — show menu, TFA keeps running
            _kb["menu"] = True
            while True:
                await asyncio.sleep(0.05)
                if not _msvcrt.kbhit():
                    continue
                ch2 = _msvcrt.getwch()
                if ch2 == "\x1b":           # Esc → exit
                    _kb["menu"] = False
                    _kb["action"] = "exit"
                    raise asyncio.CancelledError
                elif ch2 in ("\r", "\n"):   # Enter → restart
                    _kb["menu"] = False
                    _kb["action"] = "restart"
                    raise asyncio.CancelledError
                elif ch2.lower() == "c":    # C → continue
                    _kb["menu"] = False
                    break                   # back to outer loop

    async def _auto_stop():
        """Wait briefly for final flushes then cancel all tasks cleanly."""
        await asyncio.sleep(10)
        raise asyncio.CancelledError

    async def _session_end_enforcer():
        """
        Wall-clock safety net: if IST time crosses session_end + 10s and TFA
        is still running for any reason (callback didn't fire, stuck poller,
        etc.), force exit. Checks every 30s — cheap and robust.
        """
        while True:
            await asyncio.sleep(30)
            try:
                now_ist = datetime.now(_IST)
                today = now_ist.strftime("%Y-%m-%d")
                end_sec = _session_boundary_sec(today, profile.session_end)
                if now_ist.timestamp() > end_sec + 10:
                    print(
                        f"\n  {YELLOW('◼  session_end + 10s passed')}  —  force-stopping.\n",
                        flush=True,
                    )
                    log.warn(
                        "SESSION_END_FORCE_STOP",
                        msg=f"Wall-clock passed session_end ({profile.session_end}) + 10s — force exit",
                    )
                    try:
                        recorder.on_session_close()
                    except Exception:
                        pass
                    raise asyncio.CancelledError
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warn("SESSION_END_CHECK_FAILED", msg=str(exc))

    # ── Run ───────────────────────────────────────────────────────────────────
    print()
    print(f"  {GREEN('● RUNNING')}  Press {BOLD('Esc')} for options.")
    print()

    try:
        await asyncio.gather(
            feed.run(),
            poller.run(),
            _stale_checker(),
            _recorder_flusher(),
            _tick_watchdog(),
            _session_end_enforcer(),
            _health_display(),
            _keyboard_handler(),
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

    # Use the profile FILENAME key (e.g. "nifty50") instead of instrument_name
    # lowercased ("nifty"). Matches the convention used everywhere else:
    # start-tfa.bat nifty50, data/features/<date>/nifty50_features.parquet,
    # models/nifty50/, config/model_feature_config/nifty50_feature_config.json.
    # Previously replay wrote nifty_features.parquet causing a naming mismatch.
    profile_path_obj = Path(args.instrument_profile)
    instrument_key = profile_path_obj.stem.replace("_profile", "")

    summary = replay(
        profile_path=profile_path_obj,
        instrument=instrument_key,
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
    # Use a flag set by signal handler so Ctrl+C is reliably detected on all
    # Python/Windows versions regardless of how asyncio handles SIGINT internally.
    import signal as _signal
    _kb: dict = {"action": None, "menu": False}

    def _sigint(signum, frame):
        # Ctrl+C fallback — hard stop, no menu
        raise KeyboardInterrupt

    _prev_handler = _signal.signal(_signal.SIGINT, _sigint)
    try:
        if args.mode == "live":
            asyncio.run(_run_live(profile, args, log, _kb))
        else:
            _run_replay(profile, args, log)
    except KeyboardInterrupt:
        pass
    finally:
        _signal.signal(_signal.SIGINT, _prev_handler)
        shutdown_logging()

    # ── Post-run action ───────────────────────────────────────────────────────
    if args.mode == "live" and _kb.get("action") == "restart":
        print(f"\n  {GREEN('↺ Restarting...')}\n", flush=True)
        sys.exit(75)    # bat loop picks this up and re-launches


if __name__ == "__main__":
    main()
