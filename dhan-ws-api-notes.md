# Dhan WebSocket API Notes (for implementation reference)

## Connection
URL: `wss://api-feed.dhan.co?version=2&token={accessToken}&clientId={clientId}&authType=2`
- Max 5 connections per user
- Max 5000 instruments per connection
- Max 100 instruments per subscribe message
- Server pings every 10s, auto-pong by ws library
- Disconnects after 40s no response

## Subscribe Request (JSON)
```json
{
    "RequestCode": 15,
    "InstrumentCount": 2,
    "InstrumentList": [
        { "ExchangeSegment": "NSE_FNO", "SecurityId": "1333" }
    ]
}
```

### Request Codes
- 15 = Subscribe Ticker
- 17 = Subscribe Quote
- 21 = Subscribe Full Packet
- 12 = Disconnect

## Response (Binary, Little Endian)

### Response Header (8 bytes, all packets)
| Bytes | Type   | Size | Description |
|-------|--------|------|-------------|
| 1     | byte   | 1    | Feed Response Code |
| 2-3   | int16  | 2    | Message Length |
| 4     | byte   | 1    | Exchange Segment |
| 5-8   | int32  | 4    | Security ID |

### Response Codes
- 2 = Ticker Packet
- 4 = Quote Packet
- 5 = OI Data
- 6 = Prev Close
- 8 = Full Packet
- 50 = Disconnect

### Full Packet (Code 8) - 162 bytes total
| Bytes  | Type    | Size | Field |
|--------|---------|------|-------|
| 0-8    | header  | 8    | Response Header (code 8) |
| 9-12   | float32 | 4    | LTP |
| 13-14  | int16   | 2    | Last Traded Quantity |
| 15-18  | int32   | 4    | Last Trade Time (EPOCH) |
| 19-22  | float32 | 4    | Average Trade Price |
| 23-26  | int32   | 4    | Volume |
| 27-30  | int32   | 4    | Total Sell Quantity |
| 31-34  | int32   | 4    | Total Buy Quantity |
| 35-38  | int32   | 4    | Open Interest |
| 39-42  | int32   | 4    | Highest OI (NSE_FNO only) |
| 43-46  | int32   | 4    | Lowest OI (NSE_FNO only) |
| 47-50  | float32 | 4    | Day Open |
| 51-54  | float32 | 4    | Day Close (post-market only) |
| 55-58  | float32 | 4    | Day High |
| 59-62  | float32 | 4    | Day Low |
| 63-162 | depth   | 100  | 5x Market Depth (20 bytes each) |

### Market Depth (20 bytes each, 5 levels)
| Bytes | Type    | Size | Field |
|-------|---------|------|-------|
| 1-4   | int32   | 4    | Bid Quantity |
| 5-8   | int32   | 4    | Ask Quantity |
| 9-10  | int16   | 2    | No. of Bid Orders |
| 11-12 | int16   | 2    | No. of Ask Orders |
| 13-16 | float32 | 4    | Bid Price |
| 17-20 | float32 | 4    | Ask Price |

### Exchange Segment Codes (from Annexure)
- IDX_I = 0 (Index)
- NSE_EQ = 1
- NSE_FNO = 2
- NSE_CURRENCY = 3
- BSE_EQ = 4
- MCX_COMM = 5
- BSE_CURRENCY = 7
- BSE_FNO = 8

### Feed Request Codes
- 11 = Connect Feed
- 12 = Disconnect Feed
- 15 = Subscribe Ticker
- 16 = Unsubscribe Ticker
- 17 = Subscribe Quote
- 18 = Unsubscribe Quote
- 21 = Subscribe Full Packet
- 22 = Unsubscribe Full Packet
- 23 = Subscribe Full Market Depth
- 25 = Unsubscribe Full Market Depth

### Feed Response Codes
- 1 = Index Packet
- 2 = Ticker Packet
- 4 = Quote Packet
- 5 = OI Packet
- 6 = Prev Close Packet
- 7 = Market Status Packet
- 8 = Full Packet
- 50 = Feed Disconnect

### Disconnection Error Codes
- 804 = Instruments exceed limit
- 805 = Too many connections
- 806 = Data APIs not subscribed
- 807 = Access token expired
- 808 = Auth failed
- 809 = Access token invalid
- 810 = Client ID invalid
