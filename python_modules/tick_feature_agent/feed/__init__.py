"""
tick_feature_agent.feed — Dhan WS feed + option chain REST poller.

Exports:
    DhanFeed        Asyncio WebSocket client for Dhan Live Market Feed v2.
    ChainPoller     REST poller for Dhan option chain snapshots.
    ChainSnapshot   Validated option chain snapshot value object.
    dispatch        Binary packet dispatcher (binary_parser).
    ResponseCode    Dhan WS response code constants.
    RequestCode     Dhan WS request code constants.
"""

from tick_feature_agent.feed.binary_parser import (
    dispatch,
    ResponseCode,
    RequestCode,
    EXCHANGE_SEGMENT_CODE,
    EXCHANGE_SEGMENT_NAME,
)
from tick_feature_agent.feed.dhan_feed import DhanFeed
from tick_feature_agent.feed.chain_poller import ChainPoller, ChainSnapshot

__all__ = [
    "DhanFeed",
    "ChainPoller",
    "ChainSnapshot",
    "dispatch",
    "ResponseCode",
    "RequestCode",
    "EXCHANGE_SEGMENT_CODE",
    "EXCHANGE_SEGMENT_NAME",
]
