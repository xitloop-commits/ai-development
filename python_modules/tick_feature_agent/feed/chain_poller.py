"""
chain_poller.py — Asyncio REST poller for Dhan option chain snapshots.

Polls GET /api/broker/option-chain via the Node.js broker service every 5s.
Node.js handles the Dhan REST call and caching — TFA gets a clean snapshot.

Responsibilities:
  - Expiry resolution at startup (nearest active expiry)
  - Security ID verification (profile vs API)
  - Strike step detection (from chain strikes)
  - Clock skew detection (chain_ts vs tick_ts)
  - Expiry rollover detection (~14:30 IST)
  - New strikes detection (subscribe new security_ids)
  - Expose current validated snapshot to chain_cache.py

Chain snapshot response from /api/broker/option-chain:
    {
      "success": true,
      "data": {
        "underlying": "<security_id>",
        "expiry": "YYYY-MM-DD",
        "spotPrice": 24150.5,
        "timestamp": <unix_ms>,
        "rows": [
          {
            "strike": 24000,
            "callOI": 5000, "callOIChange": 500, "callLTP": 245.5,
            "callVolume": 1200, "callIV": 18.5, "callSecurityId": "52175",
            "putOI": 3000, "putOIChange": 200, "putLTP": 95.25,
            "putVolume": 800, "putIV": 17.2, "putSecurityId": "52176"
          }, ...
        ]
      }
    }
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone, timedelta, date as _date
from typing import Callable

try:
    import requests as _requests
except ImportError:
    raise ImportError("requests package not installed. Run: pip install requests")

from tick_feature_agent.instrument_profile import InstrumentProfile
from tick_feature_agent.log.tfa_logger import get_logger

_IST = timezone(timedelta(hours=5, minutes=30))
_ROLLOVER_HOUR = 14
_ROLLOVER_MINUTE = 30
_CLOCK_SKEW_MAX_SEC = 2.0
_POLL_INTERVAL_SEC = 5.0
_CHAIN_STALE_AFTER_SEC = 30.0
_STARTUP_RETRY_MAX = 12
_STARTUP_RETRY_INTERVAL_SEC = 5.0

# Exchange segment to use when querying the option chain via Node.js.
# NSE uses IDX_I (index segment) — NOT NSE_FNO. Dhan's option chain API
# expects the underlying's own segment. NIFTY/BANKNIFTY index (security_id 13/25)
# live in IDX_I. Using NSE_FNO with security_id 13 returns a DIFFERENT instrument
# (spot ~7000 instead of ~24300) — this bug kept NSE option features null since day 1.
_CHAIN_EXCHANGE_SEG: dict[str, str] = {
    "NSE": "IDX_I",
    "MCX": "MCX_COMM",
}


class ChainSnapshot:
    """Validated, parsed option chain snapshot."""

    __slots__ = (
        "spot_price", "expiry", "timestamp_sec", "rows",
        "strike_step", "sec_id_map", "recv_ts",
    )

    def __init__(
        self,
        spot_price: float,
        expiry: str,
        timestamp_sec: float,
        rows: list[dict],
        strike_step: int,
        sec_id_map: dict[str, tuple[int, str]],
    ) -> None:
        self.spot_price     = spot_price
        self.expiry         = expiry
        self.timestamp_sec  = timestamp_sec
        self.rows           = rows            # list of row dicts from API
        self.strike_step    = strike_step
        self.sec_id_map     = sec_id_map      # {security_id: (strike, opt_type)}
        self.recv_ts        = time.time()

    @property
    def strikes(self) -> list[int]:
        return sorted(r["strike"] for r in self.rows)


class ChainPoller:
    """
    Polls the Node.js broker REST endpoint every 5 seconds for the option chain.

    Call `await run()` as an asyncio task. The current validated snapshot is
    accessible via the `snapshot` property.
    """

    def __init__(
        self,
        profile: InstrumentProfile,
        broker_url: str = "http://localhost:3000",
        on_snapshot: Callable[[ChainSnapshot], None] | None = None,
        on_rollover: Callable[[str], None] | None = None,
        on_new_strikes: Callable[[dict[str, tuple[int, str]]], None] | None = None,
        on_chain_stale: Callable[[], None] | None = None,
        on_chain_recovered: Callable[[], None] | None = None,
        underlying_security_id: str | None = None,
    ) -> None:
        """
        Args:
            profile:           InstrumentProfile for this TFA process.
            broker_url:        Base URL of the Node.js broker service.
            on_snapshot:       Called with the validated ChainSnapshot on each poll.
            on_rollover:       Called with new expiry string when rollover is detected.
            on_new_strikes:    Called with new sec_id_map entries when new strikes appear.
            on_chain_stale:    Called when no snapshot received for >30s.
            on_chain_recovered: Called when chain snapshot resumes after stale.
            underlying_security_id:
                Override for the Dhan option-chain 'UnderlyingScrip' parameter.
                For MCX (commodity options), this MUST be the currently-active
                near-month futures security_id resolved at TFA startup via
                scrip-master. The profile's static value rots every month when
                the front-month contract expires - using it causes Dhan to
                return HTTP 400 on the option-chain expiry-list call and TFA
                halts at startup (observed 2026-04-21 after the April crude
                contract expired on 2026-04-20). For NSE (IDX_I) the profile's
                static index id is stable, so this override is optional there.
        """
        self._profile = profile
        self._broker_url = broker_url.rstrip("/")
        self._on_snapshot = on_snapshot
        self._on_rollover = on_rollover
        self._on_new_strikes = on_new_strikes
        self._on_chain_stale = on_chain_stale
        self._on_chain_recovered = on_chain_recovered

        self._log = get_logger("tfa.chain_poller", instrument=profile.instrument_name)

        self._underlying_sec_id = (
            underlying_security_id or profile.underlying_security_id
        )
        self._snapshot: ChainSnapshot | None = None
        self._active_expiry: str | None = None
        self._rolled_over = False
        self._last_good_ts: float = 0.0
        self._stale_notified = False
        self._running = False
        self._exch_seg = _CHAIN_EXCHANGE_SEG.get(profile.exchange, "NSE_FNO")

    @property
    def snapshot(self) -> ChainSnapshot | None:
        """Current validated chain snapshot, or None if not yet fetched."""
        return self._snapshot

    @property
    def active_expiry(self) -> str | None:
        return self._active_expiry

    # ── Main polling loop ─────────────────────────────────────────────────────

    async def startup(self) -> ChainSnapshot:
        """
        Startup sequence:
          1. Resolve nearest active expiry.
          2. Fetch and validate first chain snapshot.
          3. Verify security ID.
          4. Detect strike step.
          5. Return the validated snapshot.

        Retries up to 12× with 5s intervals. Calls log.error (FATAL) on failure.
        """
        # Step 1: resolve expiry
        self._active_expiry = await self._resolve_expiry()
        self._log.info("EXPIRY_RESOLVED", msg=f"Active expiry: {self._active_expiry}",
                       expiry=self._active_expiry)

        # Step 2: fetch first chain snapshot with retries
        snapshot = None
        for attempt in range(1, _STARTUP_RETRY_MAX + 1):
            snapshot = await self._fetch_snapshot()
            if snapshot is not None:
                break
            self._log.warn(
                "CHAIN_UNAVAILABLE",
                msg=f"Chain fetch failed (attempt {attempt}/{_STARTUP_RETRY_MAX}) — retrying in {_STARTUP_RETRY_INTERVAL_SEC}s",
            )
            await asyncio.sleep(_STARTUP_RETRY_INTERVAL_SEC)

        if snapshot is None:
            self._log.error(
                "CHAIN_UNAVAILABLE",
                msg=f"Chain fetch failed after {_STARTUP_RETRY_MAX} attempts — halting",
            )

        # Step 3: security ID verification
        self._verify_security_id(snapshot)

        self._snapshot = snapshot
        self._last_good_ts = time.monotonic()
        return snapshot

    async def run(self) -> None:
        """Polling loop — call as an asyncio task after startup()."""
        self._running = True
        while self._running:
            await asyncio.sleep(_POLL_INTERVAL_SEC)
            if not self._running:
                break
            snapshot = await self._fetch_snapshot()
            if snapshot is None:
                self._check_staleness()
                continue

            # Clock skew check
            if not self._check_clock_skew(snapshot):
                continue   # reject this snapshot, use previous

            # Rollover detection
            self._check_rollover(snapshot)

            # New strikes
            if self._snapshot is not None:
                self._check_new_strikes(snapshot)

            self._snapshot = snapshot
            self._last_good_ts = time.monotonic()

            # Chain recovered
            if self._stale_notified:
                self._stale_notified = False
                if self._on_chain_recovered:
                    self._on_chain_recovered()

            if self._on_snapshot:
                self._on_snapshot(snapshot)

    async def stop(self) -> None:
        self._running = False

    # ── HTTP helpers ──────────────────────────────────────────────────────────

    async def _resolve_expiry(self) -> str:
        """
        Fetch the nearest active expiry for this instrument.

        Uses the scrip-master endpoint (local cache) instead of Dhan's
        option-chain endpoint because the latter only returns monthly
        expiries for NSE instruments — missing NIFTY weekly options which
        are the most liquid contracts.
        """
        loop = asyncio.get_event_loop()
        try:
            if self._profile.exchange == "MCX":
                # MCX: use Dhan's option-chain expiry-list endpoint directly.
                # Scrip-master OPTFUT returns intermediate expiries (05-07) that
                # the chain API doesn't support — only main expiries (05-14) work.
                resp = await loop.run_in_executor(
                    None,
                    lambda: _requests.get(
                        f"{self._broker_url}/api/broker/option-chain/expiry-list",
                        params={
                            "underlying": self._underlying_sec_id,
                            "exchangeSegment": self._exch_seg,
                        },
                        timeout=10,
                    )
                )
            else:
                # NSE: use scrip-master with OPTIDX to get weekly expiries
                # (Dhan's option-chain endpoint only returns monthly for NSE)
                resp = await loop.run_in_executor(
                    None,
                    lambda: _requests.get(
                        f"{self._broker_url}/api/broker/scrip-master/expiry-list",
                        params={
                            "symbol": self._profile.instrument_name,
                            "instrumentName": "OPTIDX",
                        },
                        timeout=10,
                    )
                )
            if resp.status_code != 200:
                self._log.error(
                    "EXPIRY_FETCH_FAILED",
                    msg=f"Expiry list HTTP {resp.status_code}",
                )
            body = resp.json()
            expiries: list[str] = body.get("data", [])
            if not expiries:
                self._log.error(
                    "EXPIRY_FETCH_FAILED",
                    msg="No expiries returned from broker — halting",
                )
            today = _date.today().isoformat()
            future = sorted(e for e in expiries if e >= today)
            if not future:
                self._log.error(
                    "EXPIRY_FETCH_FAILED",
                    msg=f"No future expiries found (today={today}) — halting",
                )
            return future[0]
        except Exception as exc:
            self._log.error("EXPIRY_FETCH_FAILED", msg=f"Exception: {exc}")

    async def _fetch_snapshot(self) -> ChainSnapshot | None:
        loop = asyncio.get_event_loop()
        try:
            resp = await loop.run_in_executor(
                None,
                lambda: _requests.get(
                    f"{self._broker_url}/api/broker/option-chain",
                    params={
                        "underlying": self._underlying_sec_id,
                        "expiry": self._active_expiry,
                        "exchangeSegment": self._exch_seg,
                    },
                    timeout=8,
                )
            )
            if resp.status_code != 200:
                return None
            body = resp.json()
            if not body.get("success"):
                return None
            return self._parse_snapshot(body["data"])
        except Exception as exc:
            self._log.warn("CHAIN_FETCH_ERROR", msg=str(exc))
            return None

    def _parse_snapshot(self, data: dict) -> ChainSnapshot | None:
        try:
            rows = data.get("rows", [])
            if not rows:
                return None
            spot_price = float(data.get("spotPrice", 0))
            expiry     = data.get("expiry", self._active_expiry or "")
            ts_ms      = data.get("timestamp", time.time() * 1000)
            ts_sec     = ts_ms / 1000.0 if ts_ms > 1e9 else ts_ms

            strike_step = self._detect_strike_step(rows)
            if strike_step == 0:
                self._log.error(
                    "CORRUPT_CHAIN_DATA",
                    msg="strike_step = 0 — halting",
                    row_count=len(rows),
                )

            # Build security_id → (strike, opt_type) map
            sec_id_map: dict[str, tuple[int, str]] = {}
            for row in rows:
                strike = int(row["strike"])
                call_id = row.get("callSecurityId")
                put_id  = row.get("putSecurityId")
                if call_id:
                    sec_id_map[str(call_id)] = (strike, "CE")
                if put_id:
                    sec_id_map[str(put_id)] = (strike, "PE")

            return ChainSnapshot(
                spot_price=spot_price,
                expiry=expiry,
                timestamp_sec=ts_sec,
                rows=rows,
                strike_step=strike_step,
                sec_id_map=sec_id_map,
            )
        except Exception as exc:
            self._log.warn("CHAIN_PARSE_ERROR", msg=str(exc))
            return None

    # ── Strike step detection ─────────────────────────────────────────────────

    def _detect_strike_step(self, rows: list[dict]) -> int:
        strikes = sorted(int(r["strike"]) for r in rows)
        if len(strikes) < 2:
            self._log.error(
                "CORRUPT_CHAIN_DATA",
                msg=f"Fewer than 2 strikes in chain ({len(strikes)}) — halting",
            )
        diffs = [strikes[i+1] - strikes[i] for i in range(len(strikes)-1)]
        step = min(diffs)
        if step <= 0:
            return 0
        return step

    # ── Security ID verification ──────────────────────────────────────────────

    def _verify_security_id(self, snapshot: ChainSnapshot) -> None:
        """
        Verify that the profile's underlying_security_id matches what Dhan
        actually uses for this instrument.

        The option chain snapshot's sec_id_map confirms the option security IDs,
        and the spot_price being non-zero confirms the underlying is live.
        If spot_price is 0 or rows are empty, the security_id is likely wrong.
        """
        if snapshot.spot_price <= 0:
            self._log.error(
                "SECURITY_ID_MISMATCH",
                msg=(
                    f"Chain returned spot_price=0 for underlying_symbol="
                    f"'{self._profile.underlying_symbol}' "
                    f"(underlying_security_id='{self._underlying_sec_id}'). "
                    f"Verify underlying_security_id in the instrument profile JSON."
                ),
            )
        if not snapshot.rows:
            self._log.error(
                "SECURITY_ID_MISMATCH",
                msg=(
                    f"Chain returned 0 rows for underlying_symbol="
                    f"'{self._profile.underlying_symbol}'. "
                    f"Verify underlying_security_id in the instrument profile JSON."
                ),
            )
        self._log.info(
            "SECURITY_ID_OK",
            msg=f"Security ID verified — spot={snapshot.spot_price:.2f}, "
                f"strikes={len(snapshot.rows)}, step={snapshot.strike_step}",
            underlying_security_id=self._underlying_sec_id,
        )

    # ── Clock skew check ──────────────────────────────────────────────────────

    def _check_clock_skew(self, snapshot: ChainSnapshot) -> bool:
        """
        Return True (accept) if chain_ts ≤ now + 2s.
        Return False (reject) if chain_ts is >2s in the future.
        """
        now_sec = time.time()
        skew = snapshot.timestamp_sec - now_sec
        if skew > _CLOCK_SKEW_MAX_SEC:
            self._log.warn(
                "CLOCK_SKEW_DETECTED",
                msg=f"Chain timestamp {skew:.1f}s ahead of wall clock — rejecting snapshot",
                skew_sec=round(skew, 2),
            )
            return False
        return True

    # ── Rollover detection ────────────────────────────────────────────────────

    def _check_rollover(self, snapshot: ChainSnapshot) -> None:
        if self._rolled_over:
            return
        now_ist = datetime.now(_IST)
        rollover_time = now_ist.replace(
            hour=_ROLLOVER_HOUR, minute=_ROLLOVER_MINUTE, second=0, microsecond=0
        )
        if now_ist < rollover_time:
            return

        # Check if current expiry is today
        today_iso = now_ist.date().isoformat()
        if self._active_expiry != today_iso:
            return   # expiry is not today — no rollover needed

        self._rolled_over = True
        self._log.info(
            "EXPIRY_ROLLOVER",
            msg=f"Expiry rollover triggered at {now_ist.strftime('%H:%M')} IST",
            old_expiry=self._active_expiry,
        )
        if self._on_rollover:
            self._on_rollover(self._active_expiry)

    # ── New strikes detection ─────────────────────────────────────────────────

    def _check_new_strikes(self, new_snapshot: ChainSnapshot) -> None:
        old_ids = set(self._snapshot.sec_id_map.keys()) if self._snapshot else set()
        new_ids = set(new_snapshot.sec_id_map.keys())
        added = new_ids - old_ids
        if not added:
            return
        new_entries = {k: new_snapshot.sec_id_map[k] for k in added}
        self._log.info(
            "NEW_STRIKES_DETECTED",
            msg=f"{len(new_entries)} new security IDs detected in chain",
            count=len(new_entries),
        )
        if self._on_new_strikes:
            self._on_new_strikes(new_entries)

    # ── Staleness tracking ────────────────────────────────────────────────────

    def _check_staleness(self) -> None:
        if self._last_good_ts == 0.0:
            return
        age = time.monotonic() - self._last_good_ts
        if age > _CHAIN_STALE_AFTER_SEC and not self._stale_notified:
            self._stale_notified = True
            self._log.warn(
                "CHAIN_STALE",
                msg=f"No chain snapshot for {age:.0f}s",
                age_sec=round(age, 1),
            )
            if self._on_chain_stale:
                self._on_chain_stale()
