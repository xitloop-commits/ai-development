---
name: MCX near-month rollover breaks chain_poller (2026-04-21)
description: Profile's static underlying_security_id goes stale on MCX each month when front-month futures expire. Fixed by letting main.py pass the freshly-resolved id into ChainPoller; profile values are now fallback-only for MCX.
type: project
originSessionId: e9b47b10-0d15-43ee-b09b-d2492cad3bfb
---
# MCX chain_poller stale underlying_security_id

**Symptom:** CRUDEOIL TFA refused to start on 2026-04-21 03:30 IST with
`[BSA:Dhan] getExpiryList(486502, MCX_COMM) -> status=400, ok=false, data=null`.
TFA halted at startup with "No expiries returned from broker — halting".

**Why:** The CRUDEOIL April 2026 futures contract expired on 2026-04-20.
`config/instrument_profiles/crudeoil_profile.json` held `underlying_security_id=
"486502"`, which was the formerly-current near-month. Once it expired, Dhan's
`/optionchain/expirylist` API started returning an empty list for that id,
which the adapter surfaces as `success:true, data:[]`. ChainPoller saw an
empty future-expiry list and halted.

`main.py` already resolves the fresh near-month id via
`_resolve_near_month_contract` and uses it for WS ticks — which is why
yesterday's CRUDEOIL tick data was captured fine. The bug was that
`ChainPoller` was constructed with just `profile=...`, so it kept reading
`profile.underlying_security_id` (stale).

**Fix:** `ChainPoller.__init__` takes a new optional
`underlying_security_id` parameter. `main.py` passes the resolved
`ws_security_id` on MCX only. For NSE, the profile's static IDX_I id
(NIFTY=13, BANKNIFTY=25) is stable and correct — passing `ws_security_id`
there would be wrong because on NSE it's the FUTIDX contract, not the
spot index.

**How to apply going forward:**
- MCX profiles' `underlying_security_id` is now a fallback, not the
  authoritative id. Don't rely on it in new code paths; resolve at runtime.
- Any new code that calls Dhan's option-chain API for an MCX instrument
  MUST use a runtime-resolved near-month futures id, never a profile-static
  id.
- Analogous concern for MCX monthly rollover days (19th/20th of expiry
  month) — if the user wakes a TFA between contract expiry and Dhan's
  scrip-master refresh, a brief window exists where even the resolver can
  fail. Watch for that on the first trading day after MCX expiry.
