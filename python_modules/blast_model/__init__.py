"""blast_model — the brand-new NIFTY 50 premium blast model (clean slate).

Locked rules (docs/PROJECT_TODO.md, Partha 2026-09-07):
- Carries NOTHING from the old stack: no tick_feature_agent imports, no old
  parquets, no sma_model code. The ONLY input is data/raw/<date>/nifty50_*.
- Learns: ENTER (premium blasts >+X% within W minutes, strike baked in),
  EXIT (blast over). HH+HL structure is the gate; confidence weighs the
  circumstances (greeks, IV, decay, OI buildup, flow velocity, imbalance).
- Nifty 50 alone until it proves itself.
"""

__all__ = ["config", "raw_reader", "candles", "greeks", "flow", "labels", "dataset"]
