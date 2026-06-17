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
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Force UTF-8 output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── Path setup ────────────────────────────────────────────────────────────────
_HERE = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
_PROJECT_ROOT = _PYTHON_MODULES.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

from tick_feature_agent.instrument_profile import ProfileValidationError, load_profile
from tick_feature_agent.log.tfa_logger import get_logger, setup_logging, shutdown_logging

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
        _k32.SetConsoleMode(
            _STDOUT_HANDLE, _mode.value | 0x0004
        )  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
    except Exception:
        pass

_NO_COLOUR = bool(os.environ.get("NO_COLOR"))
_NO_CURSOR = not sys.stdout.isatty()  # piped/redirected — no in-place refresh


def _c(code: str, text: str) -> str:
    return text if _NO_COLOUR else f"\033[{code}m{text}\033[0m"


GREEN = lambda t: _c("32", t)
YELLOW = lambda t: _c("33", t)
RED = lambda t: _c("31", t)
CYAN = lambda t: _c("36", t)
BOLD = lambda t: _c("1", t)
DIM = lambda t: _c("2", t)

TICK = GREEN("✓")
CROSS = RED("✗")
PEND = YELLOW("○")

_IST = timezone(timedelta(hours=5, minutes=30))


# ── Market-open gate (live mode only) ────────────────────────────────────────


def _market_closed_reason(profile, now_ist: datetime) -> str | None:
    """Return a human-readable reason if TFA should NOT start today for this
    instrument, or None if it is OK to proceed. Live mode only — replay mode
    is date-bounded and never hits this gate.

    Blocks when:
      - Today is Saturday or Sunday
      - Today is a published market holiday (config/market_holidays.json)
      - Today's session_close (from profile JSON) has already passed

    Allows pre-market — e.g. an 08:55 AM start for an NSE instrument whose
    session opens at 09:15 is fine. The existing wait-for-session logic in
    SessionManager handles that gap.
    """
    weekday = now_ist.weekday()  # Mon=0 .. Sun=6
    if weekday == 5:
        return "today is Saturday (no NSE/MCX session)"
    if weekday == 6:
        return "today is Sunday (no NSE/MCX session)"

    try:
        from market_calendar import is_market_holiday
        if is_market_holiday(now_ist.date()):
            return f"today ({now_ist.date().isoformat()}) is a published market holiday"
    except Exception:
        # Fail-open: never let a broken holiday file block a real session.
        pass

    # session_close format in profile: "HH:MM" IST. Compare against now_ist.
    sess_close_str = getattr(profile, "session_end", None) or getattr(profile, "session_close", None)
    if sess_close_str:
        try:
            hh, mm = sess_close_str.split(":")
            close_dt = now_ist.replace(
                hour=int(hh), minute=int(mm), second=0, microsecond=0,
            )
            if now_ist > close_dt:
                return (
                    f"today's {profile.exchange} session for "
                    f"{profile.instrument_name} closed at {sess_close_str} IST "
                    f"(it is now {now_ist.strftime('%H:%M')} IST)"
                )
        except (ValueError, AttributeError):
            # Malformed session_end — fail-open, proceed normally.
            pass

    return None  # OK to start


def _notify_yow_partha(text: str, log) -> bool:
    """Best-effort one-line push to the yow-partha Telegram channel.

    Reads YOW_PARTHA_BOT_TOKEN + YOW_PARTHA_CHAT_ID from env (the same vars
    yow-partha itself uses, set in the project .env). If either is missing
    the function logs a WARN and returns False — the caller still proceeds
    with whatever it was doing. The send uses Telegram's plain HTTP API so
    we avoid pulling python-telegram-bot into TFA's import surface just to
    push a single line.
    """
    token = os.environ.get("YOW_PARTHA_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("YOW_PARTHA_CHAT_ID", "").strip()
    if not token or not chat_id:
        log.warn(
            "YOW_PARTHA_NOTIFY_SKIPPED",
            msg="YOW_PARTHA_BOT_TOKEN or YOW_PARTHA_CHAT_ID missing — Telegram notify skipped",
        )
        return False
    try:
        import urllib.parse
        import urllib.request
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
        with urllib.request.urlopen(url, data=data, timeout=5) as resp:
            ok = resp.status == 200
        if not ok:
            log.warn(
                "YOW_PARTHA_NOTIFY_FAILED",
                msg=f"Telegram sendMessage returned status={resp.status}",
            )
        return ok
    except Exception as exc:
        log.warn("YOW_PARTHA_NOTIFY_FAILED", msg=str(exc))
        return False


# ── Session-close hooks (auto-replay + API graceful stop) ────────────────────


def _is_replay_already_running(instrument: str, date_str: str) -> bool:
    """True if a `tick_feature_agent.main --mode replay` process is already
    running for this (instrument, date). Prevents double-spawn when the
    operator manually launched a replay near session-close — TFA's hook
    would otherwise race against it and trip the writer-lock error.

    Uses PowerShell's Get-CimInstance Win32_Process to scan command lines
    (matches the dedup style already in startup/stop-all.ps1). Failure to
    enumerate (PS unavailable, timeout) is non-fatal — returns False so the
    spawn proceeds; the writer-lock would catch a true collision anyway.
    """
    try:
        import subprocess
        result = subprocess.run(
            [
                "powershell", "-NoProfile", "-Command",
                (
                    "Get-CimInstance Win32_Process -Filter \"Name = 'python.exe'\" "
                    "-ErrorAction SilentlyContinue | "
                    "Where-Object { "
                    f"  $_.CommandLine -match 'tick_feature_agent.main' -and "
                    f"  $_.CommandLine -match '--mode replay' -and "
                    f"  $_.CommandLine -match '{instrument}' -and "
                    f"  $_.CommandLine -match '{date_str}' "
                    "} | Measure-Object | Select-Object -ExpandProperty Count"
                ),
            ],
            capture_output=True, text=True, timeout=10,
        )
        count = int((result.stdout or "0").strip() or "0")
        return count > 0
    except Exception:
        return False


def _spawn_auto_replay(instrument_key: str, log) -> None:
    """Detached subprocess: start-replay.bat <instrument-key> --date <today>.

    Called from TFA's _on_session_close_h after SESSION_AUTO_STOP. Runs in a
    separate cmd.exe window via the same launcher path the operator uses
    manually; LUBAS_HEADLESS=1 in the spawn env so the wrapper bat skips its
    interactive 2-minute auto-close timeout. Failures (file missing, dedup
    skip, non-zero spawn) all ping yow-partha so Partha is aware.

    ``instrument_key`` is the lowercase profile-filename key (e.g.
    ``"banknifty"``, ``"nifty50"``) — NOT ``profile.instrument_name``
    (uppercase semantic name like ``"BANKNIFTY"``, ``"NIFTY"``). The
    rest of the pipeline (metadata.json keys, parquet filenames,
    checkpoint, lifecycle tags ``replay-banknifty``) all use the
    lowercase form; the auto-replay invocation must match or
    ``run_one_date`` will fail the ``meta["instruments"][key]`` lookup
    and SKIP-and-exit immediately (2026-06-16 incident).
    """
    today_ist = datetime.now(_IST).strftime("%Y-%m-%d")
    inst = instrument_key

    if _is_replay_already_running(inst, today_ist):
        log.info(
            "AUTO_REPLAY_SKIPPED",
            msg=f"Auto-replay skipped — replay already running for {inst} {today_ist}",
            instrument=inst,
            date=today_ist,
        )
        _notify_yow_partha(
            f"⏭ Auto-replay skipped — already running for {inst} on {today_ist}",
            log,
        )
        return

    bat = Path(__file__).resolve().parents[2] / "startup" / "start-replay.bat"
    if not bat.exists():
        log.warn(
            "AUTO_REPLAY_BAT_MISSING",
            msg=f"start-replay.bat not found at {bat}",
        )
        _notify_yow_partha(
            f"⚠ Auto-replay launch FAILED for {inst} on {today_ist}: start-replay.bat missing",
            log,
        )
        return

    try:
        import subprocess
        env = os.environ.copy()
        env["LUBAS_HEADLESS"] = "1"
        creation_flags = 0
        if sys.platform == "win32":
            # Detached + new console so the spawn survives TFA exit and gets
            # its own cmd window for visibility.
            creation_flags = (
                subprocess.CREATE_NEW_CONSOLE | subprocess.CREATE_NEW_PROCESS_GROUP
            )
        subprocess.Popen(
            ["cmd.exe", "/c", str(bat), inst, "--date", today_ist],
            env=env,
            cwd=str(bat.resolve().parents[1]),
            creationflags=creation_flags,
            close_fds=True,
        )
        log.info(
            "AUTO_REPLAY_SPAWNED",
            msg=f"Auto-replay spawned for {inst} on {today_ist}",
            instrument=inst,
            date=today_ist,
        )
    except Exception as exc:
        log.warn(
            "AUTO_REPLAY_SPAWN_FAILED",
            msg=f"Auto-replay spawn FAILED for {inst} on {today_ist}: {exc}",
            instrument=inst,
            date=today_ist,
            error=str(exc),
        )
        _notify_yow_partha(
            f"⚠ Auto-replay spawn FAILED for {inst} on {today_ist}: {exc}",
            log,
        )


def _spawn_api_graceful_stop(log) -> None:
    """Fire-and-forget invocation of startup/_stop-api-graceful.ps1.

    The helper finds server_launcher.py's PID and sends Ctrl+C via the
    existing _send-ctrlc-helper.ps1 pattern, then force-kills if it doesn't
    exit within 5s. We don't wait for completion — the API can take a few
    seconds to shut down cleanly and we don't want to block TFA's own auto-
    stop. Errors are logged but otherwise silent; the API will be force-
    killed by start-all.bat's restart-fresh logic at 08:55 anyway.
    """
    helper = Path(__file__).resolve().parents[2] / "startup" / "_stop-api-graceful.ps1"
    if not helper.exists():
        log.warn(
            "API_STOP_HELPER_MISSING",
            msg=f"_stop-api-graceful.ps1 not found at {helper}",
        )
        return
    try:
        import subprocess
        subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", str(helper), "-Quiet"],
            close_fds=True,
        )
        log.info(
            "API_STOP_REQUESTED",
            msg="Sent graceful-stop request to API (MCX session close)",
        )
    except Exception as exc:
        log.warn("API_STOP_SPAWN_FAILED", msg=str(exc))


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


def _authed_headers() -> dict[str, str]:
    """B1: include X-Internal-Token from env on every Node-API call.
    Empty string when secret unset → header omitted, server runs in
    warn-only mode."""
    secret = os.environ.get("INTERNAL_API_SECRET", "")
    return {"X-Internal-Token": secret} if secret else {}


# ── Credentials helper ────────────────────────────────────────────────────────


def _fetch_credentials(base_url: str, broker_id: str = "dhan-primary-ac") -> dict | None:
    try:
        import requests
    except ImportError:
        return None
    try:
        resp = requests.get(
            f"{base_url}/api/broker/token",
            params={"brokerId": broker_id},
            headers=_authed_headers(),
            timeout=5,
        )
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

        r = _req.get(
            f"{base_url}/api/broker/scrip-master/status", headers=_authed_headers(), timeout=5
        )
        if r.status_code == 200 and r.json().get("data", {}).get("isLoaded"):
            return True
        # Not loaded — trigger a full refresh (BSA fetches ~250k scrips from Dhan)
        log.info("SCRIP_MASTER_REFRESH", msg="Scrip master not loaded — triggering refresh")
        r2 = _req.post(
            f"{base_url}/api/broker/scrip-master/refresh", headers=_authed_headers(), timeout=60
        )
        if r2.status_code == 200:
            log.info("SCRIP_MASTER_REFRESH_OK", msg="Scrip master refresh complete")
            return True
        log.warn(
            "SCRIP_MASTER_REFRESH_FAIL", msg=f"Scrip master refresh failed: http_{r2.status_code}"
        )
        return False
    except Exception as exc:
        log.warn("SCRIP_MASTER_REFRESH_FAIL", msg=f"Scrip master check error: {exc}")
        return False


def _resolve_vix_security_id(base_url: str) -> tuple[str, str]:
    """Resolve India VIX securityId via the BSA scrip-master lookup.

    Phase 2d-01 originally hardcoded "264969" which is Dhan's REST-API ID
    for VIX. The binary WS feed uses scrip-master IDs which differ (VIX is
    "21"). Resolving dynamically at startup — same pattern as the underlying
    contract — keeps us robust to ID rotation.

    Returns (security_id, source) where source is "scrip_master" on success
    or "fallback" if BSA is unreachable / lookup fails. Fallback id is "21",
    the known-correct binary-feed VIX id confirmed 2026-05-19.
    """
    fallback_id = "21"
    try:
        import requests as _req

        r = _req.get(
            f"{base_url}/api/broker/scrip-master/lookup",
            params={"symbol": "INDIAVIX", "instrumentName": "INDEX"},
            headers=_authed_headers(),
            timeout=5,
        )
        if r.status_code != 200:
            return fallback_id, "fallback"
        body = r.json()
        if not body.get("success"):
            return fallback_id, "fallback"
        sec_id = str(body.get("data", {}).get("securityId", "")).strip()
        if not sec_id:
            return fallback_id, "fallback"
        return sec_id, "scrip_master"
    except Exception:
        return fallback_id, "fallback"


def _resolve_near_month_contract(base_url: str, profile) -> tuple[str, str, str]:
    """Resolve the near-month futures contract for a TFA instrument.

    Returns a 3-tuple `(security_id, underlying_symbol, source)` where
    `source` is one of:

        "scrip_master"  — fresh resolution from Dhan's scrip-master endpoint
        "fallback"      — every resolution attempt failed; values come
                          from the profile JSON. The caller must treat
                          this as a startup-blocking error per Phase E7
                          (PY-119): on NSE the fallback id is the SPOT
                          index (e.g. 13 for NIFTY) which is wrong for
                          the WS feed subscription; on MCX the fallback
                          id is last month's expired FUTCOM contract
                          which fails at chain-poller startup anyway
                          (the original 2026-04-21 CRUDEOIL halt
                          symptom). Either way, surfacing the failure
                          early with a clear message beats silently
                          subscribing to the wrong instrument.

    NSE instruments (NIFTY, BANKNIFTY):
      - Queries scrip master for nearest FUTIDX expiry
      - Returns (futures_security_id, e.g. "66691") and symbol (e.g. "NIFTY25APRFUT")
    MCX instruments (CRUDEOIL, NATURALGAS):
      - Queries scrip master for nearest FUTCOM expiry
      - Same structure, different instrument type
    """
    fallback_id = profile.ws_security_id or profile.underlying_security_id
    fallback_sym = profile.underlying_symbol
    instrument_type = "FUTCOM" if profile.exchange == "MCX" else "FUTIDX"
    symbol = profile.instrument_name  # "NIFTY", "BANKNIFTY", "CRUDEOIL", ...

    try:
        from datetime import date as _date

        import requests as _req

        r = _req.get(
            f"{base_url}/api/broker/scrip-master/expiry-list",
            params={"symbol": symbol, "instrumentName": instrument_type},
            headers=_authed_headers(),
            timeout=5,
        )
        if r.status_code != 200:
            return fallback_id, fallback_sym, "fallback"

        expiries = r.json().get("data", [])
        today = _date.today().isoformat()
        future = sorted(e for e in expiries if e >= today)
        if not future:
            return fallback_id, fallback_sym, "fallback"

        r2 = _req.get(
            f"{base_url}/api/broker/scrip-master/lookup",
            params={"symbol": symbol, "instrumentName": instrument_type, "expiry": future[0]},
            headers=_authed_headers(),
            timeout=5,
        )
        if r2.status_code != 200:
            return fallback_id, fallback_sym, "fallback"

        body = r2.json()
        if not body.get("success"):
            return fallback_id, fallback_sym, "fallback"

        data = body.get("data", {})
        sec_id = str(data.get("securityId", "")).strip()
        symbol_str = str(data.get("tradingSymbol", "")).strip()
        if not sec_id:
            return fallback_id, fallback_sym, "fallback"

        return sec_id, symbol_str or fallback_sym, "scrip_master"
    except Exception:
        return fallback_id, fallback_sym, "fallback"


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
            headers=_authed_headers(),
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
        return  # requests not available — skip check, fail later at credential fetch

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
        int(date_str[:4]),
        int(date_str[5:7]),
        int(date_str[8:10]),
        int(h),
        int(m),
        tzinfo=_IST,
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
    from tick_feature_agent.buffers.option_buffer import OptionBufferStore
    from tick_feature_agent.buffers.tick_buffer import CircularBuffer
    from tick_feature_agent.chain_cache import ChainCache
    from tick_feature_agent.feed.chain_poller import ChainPoller
    from tick_feature_agent.feed.dhan_feed import DhanFeed
    from tick_feature_agent.output.emitter import Emitter
    from tick_feature_agent.recorder.session_recorder import SessionRecorder
    from tick_feature_agent.session import SessionManager
    from tick_feature_agent.state_machine import StateMachine
    from tick_feature_agent.tick_processor import TickProcessor

    # ── Wait until 5 minutes before market open ─────────────────────────────
    # Don't hold a Dhan WebSocket for hours pre-market — connect just before
    # session start so the connection is fresh and avoids idle-timeout stalls.
    PRE_MARKET_LEAD_MIN = 2
    now_ist = datetime.now(_IST)
    today_str = now_ist.strftime("%Y-%m-%d")
    start_sec = _session_boundary_sec(today_str, profile.session_start)
    connect_at_sec = start_sec - PRE_MARKET_LEAD_MIN * 60

    if now_ist.timestamp() < connect_at_sec:
        wait_sec = connect_at_sec - now_ist.timestamp()
        h, m = profile.session_start.split(":")
        connect_time = (
            f"{int(h):02d}:{int(m) - PRE_MARKET_LEAD_MIN:02d}"
            if int(m) >= PRE_MARKET_LEAD_MIN
            else f"{int(h) - 1:02d}:{int(m) + 60 - PRE_MARKET_LEAD_MIN:02d}"
        )
        print(
            f"\n  {YELLOW('◌')}  Market opens at {profile.session_start} IST."
            f"  Connecting at {connect_time} IST ({int(wait_sec // 60)}m away).\n",
            flush=True,
        )
        log.info(
            "PRE_MARKET_WAIT",
            msg=f"Waiting {int(wait_sec)}s until {connect_time} IST "
            f"({PRE_MARKET_LEAD_MIN}m before session_start)",
        )
        # Sleep in 30s chunks so Ctrl+C / Esc menu still works
        while time.time() < connect_at_sec:
            time.sleep(min(30, max(0, connect_at_sec - time.time())))

    # ── Wait for API server ───────────────────────────────────────────────────
    _wait_for_server(args.broker_url, log)

    # ── Fetch credentials (retry for up to 30s — server may lag after /health) ──
    creds = None
    _cred_deadline = time.monotonic() + 30
    _cred_attempt = 0
    while True:
        creds = _fetch_credentials(args.broker_url, args.broker_id)
        if creds and "_error" not in creds:
            break
        _cred_attempt += 1
        if time.monotonic() >= _cred_deadline:
            err = (creds or {}).get("_error", "unknown")
            _fatal(
                f"Cannot fetch broker credentials after retries: {err}\n"
                f"       Is the Node.js server running at {args.broker_url}?"
            )
        if _cred_attempt == 1:
            print(f"  {YELLOW('◌')}  Waiting for broker credentials …", flush=True)
        time.sleep(2)

    access_token = creds.get("accessToken") or creds.get("access_token", "")
    client_id = creds.get("clientId") or creds.get("client_id", "")
    if not access_token or not client_id:
        _fatal("Broker credentials missing accessToken or clientId")

    log.info(
        "CREDENTIALS_OK", msg="Broker credentials fetched", client_id_masked=_mask(str(client_id))
    )

    # ── Scrip master + near-month contract resolution ─────────────────────────
    print(f"  {PEND}  Resolving near-month contract …")
    _ensure_scrip_master(args.broker_url, log)
    ws_security_id, underlying_symbol, _resolve_source = _resolve_near_month_contract(
        args.broker_url, profile
    )
    if _resolve_source == "fallback":
        # Phase E7 / PY-119: silently using the profile's static value as a
        # WS-feed subscription id is dangerous. On NSE it's the SPOT index
        # (id=13/25), so the WS would subscribe to spot ticks instead of
        # FUT ticks. On MCX it's the prior-month expired FUTCOM contract,
        # which would have failed at chain-poller startup anyway (the
        # original 2026-04-21 CRUDEOIL halt symptom). Halt now with a
        # clear message rather than letting the data pipeline run on the
        # wrong subscription.
        log.warn(
            "RESOLVER_FALLBACK_RISKY",
            msg=f"Scrip-master resolution failed for {profile.instrument_name}; "
            f"profile fallback id={ws_security_id} would subscribe to the "
            f"wrong contract. Halting startup.",
            instrument=profile.instrument_name,
            exchange=profile.exchange,
            fallback_id=ws_security_id,
            fallback_symbol=underlying_symbol,
        )
        _fatal(
            f"Could not resolve near-month contract for {profile.instrument_name}. "
            f"Scrip-master endpoint unreachable or returned no future expiries. "
            f"Refusing to fall back to the profile's static id={ws_security_id} "
            f"(it's the {'spot index' if profile.exchange == 'NSE' else 'last expired FUTCOM contract'} "
            f"and would silently mis-subscribe). Check broker connectivity and retry."
        )
    log.info(
        "CONTRACT_RESOLVED",
        msg=f"Near-month contract: {underlying_symbol}  id={ws_security_id}",
        ws_security_id=ws_security_id,
        underlying_symbol=underlying_symbol,
        source=_resolve_source,
    )
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
    tick_buf = CircularBuffer(maxlen=50)
    opt_store = OptionBufferStore()
    cache = ChainCache()
    sm = StateMachine(warm_up_duration_sec=profile.warm_up_duration_sec)
    emitter = Emitter(
        file_path=args.output_file,
        socket_addr=_parse_socket(args.output_socket),
        target_windows_sec=profile.target_windows_sec,
    )
    recorder = SessionRecorder(
        instrument=instrument_key,
        data_root=args.data_root,
        underlying_symbol=underlying_symbol,  # resolved, not profile default
        underlying_security_id=profile.underlying_security_id,
        expiry="",  # set after chain_poller.startup()
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
        # T35-FU1: use effective_session_end_epoch so Muhurat /
        # MCX morning-only days return the abnormal close, not the
        # profile's default 15:30/23:30.
        from market_calendar import effective_session_end_epoch
        end_sec = effective_session_end_epoch(
            today,
            exchange=profile.exchange,
            default_hhmm=profile.session_end,
        )
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
        # Simple fix: signal restart so bat loop re-launches TFA.
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
            msg=f"Expiry rollover on {poller.active_expiry} — restarting "
            f"TFA on the next contract.",
            old_expiry=poller.active_expiry,
        )
        print(
            f"\n  {YELLOW('◼  Expiry rollover')} — restarting on next contract…\n",
            flush=True,
        )
        # Schedule clean restart via asyncio — CancelledError propagates
        # through gather, main() sees action="restart" and exits with 75.
        _kb["action"] = "restart"
        asyncio.ensure_future(_auto_stop())

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
    # For MCX, Dhan's option-chain API needs the CURRENT near-month futures
    # security_id as 'UnderlyingScrip'. The profile's static id rots every
    # month when the front-month expires, so pass the freshly-resolved
    # ws_security_id from _resolve_near_month_contract.
    # For NSE, the option chain API expects the SPOT INDEX id (IDX_I: 13, 25)
    # which is stable and already stored in profile.underlying_security_id —
    # ws_security_id holds the FUTIDX contract id (e.g. 66691) which would
    # be WRONG to use here.
    chain_underlying_id = (
        ws_security_id if profile.exchange == "MCX" else profile.underlying_security_id
    )
    poller = ChainPoller(
        profile=profile,
        broker_url=args.broker_url,
        underlying_security_id=chain_underlying_id,
        on_snapshot=processor.on_chain_snapshot,
        on_chain_stale=processor.on_chain_stale,
        on_chain_recovered=processor.on_chain_recovered,
        on_rollover=lambda new_expiry: (
            recorder.on_expiry_rollover(
                new_expiry=new_expiry,
            )
            if recorder._date
            else None
        ),
        on_new_strikes=lambda new_sec_ids: feed.subscribe_options(new_sec_ids),
    )

    # ── Startup: resolve expiry + fetch first chain snapshot ─────────────────
    print(f"\n  {PEND}  Connecting to broker chain API …")
    try:
        first_snapshot = await poller.startup()
    except Exception as exc:
        _fatal(f"Chain poller startup failed: {exc}")

    recorder._expiry = first_snapshot.expiry
    log.info(
        "CHAIN_STARTUP_OK",
        msg=f"First chain snapshot: expiry={first_snapshot.expiry}, "
        f"spot={first_snapshot.spot_price}, "
        f"strikes={len(first_snapshot.rows)}",
        expiry=first_snapshot.expiry,
    )
    _step(
        TICK,
        "Chain poller startup",
        f"expiry={first_snapshot.expiry}  spot={first_snapshot.spot_price:.0f}  "
        f"strikes={len(first_snapshot.rows)}",
    )

    # Load the first snapshot into cache now (chain poller will keep updating)
    processor.on_chain_snapshot(first_snapshot)

    # ── Health tracking state ─────────────────────────────────────────────────
    _h: dict = {
        "feed_ok": False,
        "session_open": False,
        "session_ts": None,
        "u_ticks": 0,
        "o_ticks": 0,
        "v_ticks": 0,
        "chain_snaps": 0,  # incremented AFTER startup snapshot
        "last_u_ts": None,
        "last_v_ts": None,
        "last_chain_ts": None,
        "u_ticks_prev": 0,
        "u_rate": 0.0,
        "holiday_nse": _holiday_nse,  # pre-fetched at startup
        "holiday_mcx": _holiday_mcx,
        "disconnect_code": None,
        "disconnect_reason": None,
        "retry_at": None,
        "retry_attempt": 0,
    }
    _HEALTH_INTERVAL = 3.0
    _health_nlines: list[int] = [0]  # mutable cell for closure

    def _on_underlying_tick(data: dict) -> None:
        _h["u_ticks"] += 1
        _h["last_u_ts"] = time.monotonic()
        _h["feed_ok"] = True
        session_mgr.on_tick()  # fires session_start edge trigger
        processor.on_underlying_tick(data)

    def _on_option_tick(strike: int, opt_type: str, data: dict) -> None:
        _h["o_ticks"] += 1
        processor.on_option_tick(strike, opt_type, data)

    def _on_vix_tick(data: dict) -> None:
        _h["v_ticks"] = _h.get("v_ticks", 0) + 1
        _h["last_v_ts"] = time.monotonic()
        if recorder is not None:
            recorder.record_vix_tick(data)
        processor.on_vix_tick(data)

    def _on_chain_snapshot(snap) -> None:
        _h["chain_snaps"] += 1
        _h["last_chain_ts"] = time.monotonic()
        processor.on_chain_snapshot(snap)

    # Wrap session open/close to update health
    _orig_session_open = _on_session_open  # noqa: F821 — defined above
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
        # Spawn auto-replay for THIS instrument + today's date. Dedup against
        # any already-running replay (manual launcher fires can collide with
        # this hook). Failures ping yow-partha. See _spawn_auto_replay() for
        # the full rationale.
        #
        # Pass the lowercase profile-filename key (e.g. "banknifty",
        # "nifty50"), NOT profile.instrument_name ("BANKNIFTY", "NIFTY").
        # The metadata.json keys + parquet filenames + checkpoint all
        # use the filename form; mismatching it makes run_one_date
        # SKIP-and-exit immediately. Same derivation _run_replay uses
        # at line ~1442 (2026-06-16 fix).
        _auto_replay_key = Path(args.instrument_profile).stem.replace("_profile", "")
        _spawn_auto_replay(_auto_replay_key, log)
        # MCX session close = end of day for all live feeds. The API server
        # is not needed by replay or yow-partha (verified 2026-05-20), so
        # gracefully stop it now to free resources. start-all.bat will
        # restart it fresh at 08:55 IST tomorrow.
        if profile.exchange == "MCX":
            _spawn_api_graceful_stop(log)

    # Rebuild session_mgr with wrapped callbacks (replace in-place)
    session_mgr._on_session_start = _on_session_open_h
    session_mgr._on_session_end = _on_session_close_h

    feed = DhanFeed(
        access_token=str(access_token),
        client_id=str(client_id),
        exchange=profile.exchange,
        underlying_security_id=ws_security_id,
        on_underlying_tick=_on_underlying_tick,
        on_option_tick=_on_option_tick,
        on_vix_tick=_on_vix_tick,
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
        credential_fetcher=lambda: _fetch_credentials(args.broker_url, args.broker_id),
    )

    # Subscribe underlying futures
    feed.subscribe_underlying()

    # Phase 2d-01: co-subscribe India VIX on this same WS (NSE INDEX
    # segment IDX_I). Adds the india_vix + india_vix_change_5min features
    # without consuming an extra WS-budget slot — VIX rides along on the
    # existing connection. Security id is resolved dynamically via the
    # scrip-master lookup (T23 follow-up) so future ID rotations don't
    # silently break the feed; falls back to "21" (verified 2026-05-19).
    vix_security_id, vix_source = _resolve_vix_security_id(args.broker_url)
    log.info(
        "VIX_RESOLVED",
        msg=f"India VIX subscribed: id={vix_security_id} (source={vix_source})",
        vix_security_id=vix_security_id,
        source=vix_source,
    )
    feed.subscribe_vix(security_id=vix_security_id)

    # Subscribe all options from first snapshot — use wrapped chain snapshot callback
    # for the poller's subsequent snapshots
    feed.subscribe_options(first_snapshot.sec_id_map)

    _step(
        TICK,
        "WebSocket subscribed",
        f"underlying={ws_security_id}  " f"options={len(first_snapshot.sec_id_map)}",
    )

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
        TICK_STALL_THRESHOLD_SEC = 120  # 2 minutes with no tick in open session
        CHECK_INTERVAL_SEC = 30
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
                continue  # grace window — let the feed warm up

            last_u_ts = _h.get("last_u_ts")
            # No tick ever received since session open
            if last_u_ts is None:
                age = now - session_ts
            else:
                age = now - last_u_ts

            if age > TICK_STALL_THRESHOLD_SEC:
                log.warn(
                    "FEED_WATCHDOG_STALL",
                    msg=f"No underlying ticks for {age:.0f}s while session open — "
                    f"restarting via exit code 75.",
                    tick_age_sec=round(age, 1),
                    threshold_sec=TICK_STALL_THRESHOLD_SEC,
                )
                print(
                    f"\n  {RED('FEED STALLED')}  no ticks for {age:.0f}s — "
                    f"auto-restarting...\n",
                    flush=True,
                )
                # Signal restart via the same mechanism as Esc→Enter menu
                _kb["action"] = "restart"
                raise asyncio.CancelledError

    def _render_health() -> list[str]:
        """Build health display lines (no trailing newline on each)."""
        now = time.monotonic()
        ts = datetime.now(_IST).strftime("%H:%M:%S")

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
                feed_s = (
                    RED("✗ DISCONNECTED") + f"  retry in {secs_left:.0f}s"
                    f"  (attempt {_h['retry_attempt']})"
                )
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

        # VIX — surfaces silent subscription failures (Phase 2d-01). India VIX
        # publishes every few seconds on NSE during market hours, so a >30s
        # gap on an open session is suspect. Zero ticks while session is open
        # = the subscribe path is broken (wrong security_id / entitlement).
        vix_count = _h.get("v_ticks", 0)
        last_v_ts = _h.get("last_v_ts")
        if last_v_ts is None:
            if _h["session_open"] and vix_count == 0:
                vix_s = f"{RED('●')} no ticks yet  (subscribed, session open)"
            else:
                vix_s = f"{DIM('●')} {vix_count} ticks"
        else:
            vage = now - last_v_ts
            count_str = f"{vix_count:,} ticks"
            age_str = f"(last {vage:.0f}s ago)"
            if vage > 30 and _h["session_open"]:
                vix_s = f"{YELLOW('●')} {count_str}  {YELLOW(age_str)}"
            else:
                vix_s = f"{count_str}  {age_str}"

        # Holiday status lines — one per exchange if holiday today
        holiday_lines: list[str] = []
        for exch, key in (("NSE", "holiday_nse"), ("MCX", "holiday_mcx")):
            hdata = _h.get(key, {})
            if hdata.get("isHoliday"):
                hol = hdata.get("holiday") or {}
                name = hol.get("description", "Holiday")
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
            f"  VIX     : {vix_s}",
        ]
        lines.extend(holiday_lines)

        # Dhan disconnect reason — shown until next successful connect
        if not _h["feed_ok"] and _h.get("disconnect_reason"):
            lines.append(
                f"  {RED('✗ Dhan:')}  code={_h['disconnect_code']}  "
                f"{RED(_h['disconnect_reason'])}"
            )

        lines.append(f"  {DIM('─' * W)}")

        # Always-visible hotkey footer — launcher-style. Keys are live at all
        # times, no pause state, no menu to open. Pressing R or X (or Esc, or
        # Ctrl+C) triggers the SAME graceful-shutdown path; only the exit
        # code differs (75 = bat relaunches with fresh code, 0 = clean stop).
        lines.append(
            f"  {BOLD('[R]')} Reload   "
            f"{BOLD('[X]')} Exit   "
            f"{DIM('(also: Esc / Ctrl+C → Exit)')}"
        )

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

    # ── Keyboard handler (always-active hotkeys) ─────────────────────────────
    async def _keyboard_handler():
        """
        Always-active hotkey watcher — launcher-style. No pause state.
          R / Enter   → graceful Reload  (sets _kb["action"]="restart")
          X / Esc     → graceful Exit    (sets _kb["action"]="exit")
          Ctrl+C      → also Exit, via _sigint() setting _kb["sigint_pending"]
        On any of the above, raise asyncio.CancelledError so the full
        shutdown sequence (parquet flush, recorder close, WS unsub) runs
        before the process exits. Other keys are ignored.

        Windows-only key reads (msvcrt). On non-Windows we still honour
        Ctrl+C via the sigint_pending flag — there's no keyboard polling.
        """
        if sys.platform != "win32":
            # No msvcrt — poll only the sigint flag.
            while True:
                await asyncio.sleep(0.05)
                if _kb.get("sigint_pending"):
                    _kb["sigint_pending"] = False
                    _kb["action"] = _kb.get("action") or "exit"
                    raise asyncio.CancelledError
            return  # unreachable, makes the linter happy
        import msvcrt as _msvcrt

        while True:
            await asyncio.sleep(0.05)
            # Ctrl+C path — signal handler set this flag from any thread.
            if _kb.get("sigint_pending"):
                _kb["sigint_pending"] = False
                _kb["action"] = _kb.get("action") or "exit"
                raise asyncio.CancelledError

            if not _msvcrt.kbhit():
                continue
            ch = _msvcrt.getwch()
            # Esc may be a lone keypress OR the prefix of an ANSI sequence
            # (arrow keys etc.). Drain follow-up bytes; only a SOLITARY
            # Esc counts as Exit.
            if ch == "\x1b":
                await asyncio.sleep(0.02)
                drained = False
                while _msvcrt.kbhit():
                    _msvcrt.getwch()
                    drained = True
                if drained:
                    continue  # ANSI sequence, ignore
                _kb["action"] = "exit"
                raise asyncio.CancelledError

            low = ch.lower()
            if low == "r" or ch in ("\r", "\n"):
                _kb["action"] = "restart"
                raise asyncio.CancelledError
            if low == "x":
                _kb["action"] = "exit"
                raise asyncio.CancelledError
            # everything else: ignored

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
                # T35-FU1: match the session_open helper so the
                # enforcer fires at the actual partial-session close
                # (Muhurat 19:15, MCX morning-only 17:00) rather than
                # at the profile default.
                from market_calendar import effective_session_end_epoch
                end_sec = effective_session_end_epoch(
                    today,
                    exchange=profile.exchange,
                    default_hhmm=profile.session_end,
                )
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
        processor.on_session_close()  # flush pending target rows
        recorder.on_session_close()  # flush + close gzip writers properly
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
    """Run replay for a single date, date range, or explicit date list."""
    from tick_feature_agent.replay.replay_runner import replay

    # args.include_dates is a list (action='append'); each element may itself
    # be a comma-separated list. Flatten + de-empty into one canonical list.
    raw_chunks = getattr(args, "include_dates", []) or []
    flat: list[str] = []
    for chunk in raw_chunks:
        flat.extend(d.strip() for d in str(chunk).split(",") if d.strip())
    include_dates = flat or None

    if include_dates:
        # date_from / date_to are not used when include_dates is given, but
        # the replay() signature still requires them — pass a wide stub range.
        date_from = min(include_dates)
        date_to = max(include_dates)
    elif args.date:
        # 2026-06-14: explicit single-date requests always replay regardless
        # of the checkpoint pointer. Routing through include_dates is the
        # bypass — operator typed `--date X`, they want X, not "skip if X
        # is older than the checkpoint". Range mode (--date-from / --date-to)
        # keeps the resume-from-checkpoint behaviour because that's how
        # crash recovery works for multi-day batches.
        date_from = date_to = args.date
        include_dates = [args.date]
    elif args.date_from and args.date_to:
        date_from, date_to = args.date_from, args.date_to
    else:
        _fatal("Replay mode requires --date, --date-from + --date-to, or --include-dates")

    # Use the profile FILENAME key (e.g. "nifty50") instead of instrument_name
    # lowercased ("nifty"). Matches the convention used everywhere else:
    # start-tfa.bat nifty50, data/features/<date>/nifty50_features.parquet,
    # models/nifty50/, config/model_feature_config/nifty50_feature_config.json.
    # Previously replay wrote nifty_features.parquet causing a naming mismatch.
    profile_path_obj = Path(args.instrument_profile)
    instrument_key = profile_path_obj.stem.replace("_profile", "")

    # Mirror the human-friendly mode label that used to be printed by
    # `_banner()`. It now renders inside the ProgressDashboard alt-screen
    # frame so the operator always sees instrument / mode / dates next
    # to the per-date bars — and crucially, doesn't see a stale primary-
    # screen banner after Ctrl+C tear-down.
    instrument_label = f"{profile.instrument_name}  ({profile.exchange})"
    if include_dates:
        if len(include_dates) == 1:
            mode_str = f"replay  {include_dates[0]}  ·  {instrument_label}"
        elif len(include_dates) <= 5:
            mode_str = (
                f"replay  {', '.join(include_dates)}  ·  {instrument_label}"
            )
        else:
            mode_str = (
                f"replay  {include_dates[0]} … {include_dates[-1]}  "
                f"({len(include_dates)} dates)  ·  {instrument_label}"
            )
    elif date_from == date_to:
        mode_str = f"replay  {date_from}  ·  {instrument_label}"
    else:
        mode_str = (
            f"replay  {date_from} … {date_to}  ·  {instrument_label}"
        )

    summary = replay(
        profile_path=profile_path_obj,
        instrument=instrument_key,
        date_from=date_from,
        date_to=date_to,
        raw_root=args.data_root,
        features_root=args.features_root,
        validation_root=args.validation_root,
        logger=log,
        include_dates=include_dates,
        workers=getattr(args, "workers", None),
        log_dir=args.log_dir,
        log_level=args.log_level,
        dashboard_mode_str=mode_str,
    )

    # Per-date table + checkpoint state — gives the operator a clear
    # post-run confirmation of which dates actually produced a
    # canonical parquet, the parquet's row count, and where the
    # replay_checkpoint pointer ended up. Without this, a silent
    # partial run (worker killed mid-merge) is indistinguishable from
    # a complete one in the 4-line tally.
    from tick_feature_agent.replay.replay_runner import _print_per_date_summary
    _print_per_date_summary(
        instrument_key, date_from, date_to,
        features_root=Path(args.features_root),
        checkpoint_path=Path(args.data_root) / "replay_checkpoint.json",
        explicit_dates=include_dates,
    )

    if include_dates:
        print(f"  Replay complete  (include-dates: {', '.join(include_dates)})")
    else:
        print(f"  Replay complete  ({date_from} → {date_to})")
    print(
        f"  PASS: {summary.get('pass', 0)}  "
        f"WARN: {summary.get('warn', 0)}  "
        f"FAIL: {summary.get('fail', 0)}  "
        f"SKIP: {summary.get('skip', 0)}"
    )
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
        "--instrument-profile",
        required=True,
        metavar="PATH",
        help="Path to instrument profile JSON",
    )
    parser.add_argument(
        "--mode",
        choices=["live", "replay"],
        default="live",
        help="Operating mode (default: live)",
    )
    # Single-date replay
    parser.add_argument(
        "--date",
        metavar="YYYY-MM-DD",
        help="Replay date (single date)",
    )
    # Date-range replay
    parser.add_argument("--date-from", metavar="YYYY-MM-DD", help="Replay start date")
    parser.add_argument("--date-to", metavar="YYYY-MM-DD", help="Replay end date")
    parser.add_argument(
        "--include-dates",
        action="append",
        default=[],
        metavar="YYYY-MM-DD",
        help="Date to replay. May be specified multiple times "
        "(--include-dates 2026-04-13 --include-dates 2026-04-17) or as a "
        "comma-separated list. Overrides --date / --date-from / --date-to "
        "and bypasses the replay checkpoint.",
    )
    # Output
    parser.add_argument("--output-file", metavar="PATH", default=None)
    parser.add_argument("--output-socket", metavar="HOST:PORT", default=None)
    # Paths
    parser.add_argument("--broker-url", default="http://localhost:3000")
    # Broker config to authenticate against. Defaults to the user's primary
    # account ("dhan-primary-ac"). Set to "dhan-secondary-ac" to use the spouse's account
    # (frees the primary account's WS budget for TradingDesk + order feed).
    parser.add_argument("--broker-id", default="dhan-primary-ac")
    parser.add_argument("--data-root", default="data/raw")
    parser.add_argument("--features-root", default="data/features")
    parser.add_argument("--validation-root", default="data/validation")
    # Logging
    parser.add_argument("--log-dir", default="logs", metavar="DIR")
    parser.add_argument("--log-level", choices=["DEBUG", "INFO", "WARN", "ERROR"], default="INFO")
    # T47 — replay-only: parallel fan-out across dates. Ignored in live mode.
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        metavar="N",
        help="Replay-only: max parallel date workers (default: auto = "
        "min(num_dates, 16); hard cap 20). Set to 1 for serial replay.",
    )

    args = parser.parse_args()

    # Validate replay args
    if args.mode == "replay":
        if not args.date and not (args.date_from and args.date_to) and not args.include_dates:
            parser.error(
                "Replay mode requires --date  OR  --date-from + --date-to  OR  --include-dates"
            )

    # ── Load profile ──────────────────────────────────────────────────────────
    profile_path = Path(args.instrument_profile)
    if not profile_path.is_absolute():
        profile_path = Path.cwd() / profile_path

    try:
        profile = load_profile(profile_path)
    except FileNotFoundError:
        print(f"\n  {CROSS}  Instrument profile not found: {profile_path}\n", file=sys.stderr)
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

    # ── Market-closed gate (live mode only) ──────────────────────────────────
    # Refuses to start when there is no realistic chance of receiving ticks
    # today — weekend, holiday, or post-session-close. Pre-market is allowed
    # (existing wait-for-session-open in SessionManager handles that).
    # On a block, pings yow-partha with the reason and exits 0 cleanly so
    # the .bat wrapper does NOT re-launch us in a loop.
    if args.mode == "live":
        _now_ist = datetime.now(_IST)
        _block_reason = _market_closed_reason(profile, _now_ist)
        if _block_reason:
            msg = (
                f"TFA recorder {profile.instrument_name} ({profile.exchange}) "
                f"will not start: {_block_reason}"
            )
            log.info("MARKET_CLOSED", msg=msg)
            print(f"\n  {YELLOW('●')} {msg}\n", flush=True)
            _notify_yow_partha(f"📵 {msg}", log)
            shutdown_logging()
            sys.exit(0)

    # ── Banner ────────────────────────────────────────────────────────────────
    if args.mode == "live":
        mode_str = "live"
    elif args.include_dates:
        _flat: list[str] = []
        for chunk in args.include_dates:
            _flat.extend(d.strip() for d in str(chunk).split(",") if d.strip())
        if len(_flat) == 1:
            mode_str = f"replay  {_flat[0]}"
        elif len(_flat) <= 5:
            mode_str = f"replay  {', '.join(_flat)}"
        else:
            mode_str = f"replay  {_flat[0]} … {_flat[-1]}  ({len(_flat)} dates)"
    elif args.date:
        mode_str = f"replay  {args.date}"
    else:
        mode_str = f"replay  {args.date_from} → {args.date_to}"

    # Live mode still prints the standalone banner. Replay mode skips
    # it: the ProgressDashboard alt-screen carries the same info as its
    # header so the primary screen stays clean after Ctrl+C tear-down
    # (no stale banner left over) (2026-06-14).
    if args.mode == "live":
        _banner(f"{profile.instrument_name}  ({profile.exchange})", mode_str)

    log.info(
        "TFA_START",
        msg=f"TFA starting — {profile.instrument_name} {args.mode}",
        instrument=profile.instrument_name,
        exchange=profile.exchange,
        mode=args.mode,
    )

    # ── Dispatch ──────────────────────────────────────────────────────────────
    # Use a flag set by signal handler so Ctrl+C is reliably detected on all
    # Python/Windows versions regardless of how asyncio handles SIGINT internally.
    import signal as _signal

    # Shared coordination dict between signal handler, kb_watch coroutine,
    # and the post-run code in main(). Fields:
    #   action          None | "restart" | "exit" — choice picked
    #   sigint_pending  bool — signal handler sets True; kb_watch consumes it
    _kb: dict = {"action": None, "sigint_pending": False}

    # Ctrl+C in live mode is equivalent to pressing X — no pause state, no
    # menu to open. Hotkeys [R] / [X] are always live in the health-display
    # footer. The signal handler can't raise CancelledError directly (wrong
    # stack), so it flips a flag and the always-running kb_watch coroutine
    # picks it up within 50ms and triggers the graceful shutdown sequence
    # (parquet flush → recorder close → WS unsubscribe) before exit. This
    # keeps all teardown inside the asyncio task tree where shutdown hooks
    # run in dependency order.
    #
    # Replay mode is date-bounded and has no kb_watch; Ctrl+C there raises
    # KeyboardInterrupt and the outer __main__ handler shows a simple R/X
    # prompt.
    def _sigint(signum, frame):
        if args.mode == "live":
            _kb["sigint_pending"] = True
            return
        raise KeyboardInterrupt  # replay mode: bubble to outer handler

    _prev_handler = _signal.signal(_signal.SIGINT, _sigint)
    try:
        if args.mode == "live":
            asyncio.run(_run_live(profile, args, log, _kb))
        else:
            _run_replay(profile, args, log)
    except KeyboardInterrupt:
        # Replay-mode Ctrl+C lands here; live-mode never raises (handled
        # by the pause menu instead). Either way, finally below handles
        # signal-handler restore + log flush.
        pass
    finally:
        _signal.signal(_signal.SIGINT, _prev_handler)
        shutdown_logging()

    # ── Post-run action ───────────────────────────────────────────────────────
    # Live mode honours the choice the user made in the pause menu:
    #   _kb["action"] == "restart" → exit 75 (bat relaunches fresh)
    #   _kb["action"] == "exit"    → exit 0  (bat falls through to pause)
    # Both paths run through the menu's CancelledError flow, which already
    # tears down the WS, recorder, and parquet writer GRACEFULLY before
    # this code is reached. So no extra shutdown work needed here.
    if args.mode == "live" and _kb.get("action") == "restart":
        print(f"\n  {GREEN('↺ Restarting...')}\n", flush=True)
        sys.exit(75)
    if args.mode == "live" and _kb.get("action") == "exit":
        print(f"\n  {DIM('Stopped.')}\n", flush=True)
        sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        # Outermost safety net — Ctrl+C lands here if it slips past the
        # in-process SIGINT handler / Esc-menu handler. Offer R/X.
        from _shared.restart_prompt import prompt_restart_or_exit
        sys.exit(prompt_restart_or_exit("TFA recorder"))
