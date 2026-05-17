"""
tick_feature_agent.state — Persistent per-session state writers.

Modules in this package read/write small JSON state files under
`data/state/` that bridge information across trading sessions
(e.g. previous-day H/L for cross-day level features).
"""
