"""sma-model — learned SMA5 leg-riding entry/exit model (T154).

Standalone package: reads data/raw/<date>/nifty50_*.ndjson.gz directly,
builds 1-minute Heikin-Ashi candles + SMA5 from FUTURES ticks, extracts
candle-close decision events, grades them in rupees after real charges via
recorded ATM weekly option bid/ask, trains LightGBM entry/exit heads, and
runs the Gate-1 walk-forward backtest.

MUST NOT import from or write to the 84-head MTA paths, models/<inst>/LATEST,
or LATEST_HEADS.json (spec docs/systems/11_sma_model.md §7).
"""
