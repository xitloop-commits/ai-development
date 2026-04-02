# Dhan Live Order Update WebSocket

## Endpoint
`wss://api-order-update.dhan.co`

## Auth Message
```json
{
  "LoginReq": {
    "MsgCode": 42,
    "ClientId": "1000000001",
    "Token": "JWT"
  },
  "UserType": "SELF"
}
```

## Order Update JSON Fields
- OrderNo: Dhan order ID
- ExchOrderNo: Exchange order ID
- SecurityId: scrip ID
- TxnType: B=Buy, S=Sell
- Product: C=CNC, I=INTRADAY, M=MARGIN, F=MTF
- OrderType: LMT, MKT, SL, SLM
- Status: TRANSIT, PENDING, REJECTED, CANCELLED, TRADED, EXPIRED
- Quantity, TradedQty, RemainingQuantity
- Price, TriggerPrice, TradedPrice, AvgTradedPrice
- LegNo: 1=Entry, 2=StopLoss, 3=Target
- Symbol, StrikePrice, ExpiryDate, OptType (CE/PE)
- CorrelationId: user tag (max 30 chars)
- Remarks: "Super Order" if part of super order
