# TEA Phase 1 commits 1-2 smoke test.
# Requires `pnpm dev` running on http://localhost:3000.

$ErrorActionPreference = 'Stop'
$base = 'http://localhost:3000/api/trpc'

function Invoke-Trpc {
    param([string]$Procedure, [hashtable]$Input, [string]$Method = 'POST')
    $body = @{ json = $Input } | ConvertTo-Json -Depth 8 -Compress
    if ($Method -eq 'GET') {
        $encoded = [uri]::EscapeDataString($body)
        return Invoke-RestMethod -Uri "$base/$Procedure`?input=$encoded" -Method GET
    }
    return Invoke-RestMethod -Uri "$base/$Procedure" -Method POST -ContentType 'application/json' -Body $body
}

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$execId = "smoke-$now"

Write-Host "`n=== 1. Submit a paper trade (channel=my-paper) ===" -ForegroundColor Cyan
$submit = Invoke-Trpc -Procedure 'executor.submitTrade' -Input @{
    executionId  = $execId
    channel      = 'my-paper'
    origin       = 'USER'
    instrument   = 'NIFTY_50'
    direction    = 'BUY'
    quantity     = 75
    entryPrice   = 100
    stopLoss     = 90
    takeProfit   = 120
    orderType    = 'MARKET'
    productType  = 'INTRADAY'
    timestamp    = $now
}
$submit.result.data | ConvertTo-Json -Depth 8

Write-Host "`n=== 2. Snapshot — should show 1 open position ===" -ForegroundColor Cyan
$snap = Invoke-Trpc -Procedure 'portfolio.snapshot' -Method 'GET' -Input @{ channel = 'my-paper' }
"openPositionCount = $($snap.result.data.openPositionCount)"
"openExposure      = $($snap.result.data.openExposure)"
"unrealizedPnl     = $($snap.result.data.unrealizedPnl)"

Write-Host "`n=== 3. Resubmit SAME executionId — idempotency replay ===" -ForegroundColor Cyan
$dup = Invoke-Trpc -Procedure 'executor.submitTrade' -Input @{
    executionId  = $execId
    channel      = 'my-paper'
    origin       = 'USER'
    instrument   = 'NIFTY_50'
    direction    = 'BUY'
    quantity     = 75
    entryPrice   = 100
    stopLoss     = 90
    takeProfit   = 120
    orderType    = 'MARKET'
    productType  = 'INTRADAY'
    timestamp    = $now
}
"tradeId  (1st call) = $($submit.result.data.tradeId)"
"tradeId  (2nd call) = $($dup.result.data.tradeId)  <- should match"

Write-Host "`n=== 4. Snapshot again — should STILL be 1 open position (no double) ===" -ForegroundColor Cyan
$snap2 = Invoke-Trpc -Procedure 'portfolio.snapshot' -Method 'GET' -Input @{ channel = 'my-paper' }
"openPositionCount = $($snap2.result.data.openPositionCount)"

Write-Host "`n=== 5. Live submit on my-live — should be REJECTED (commit 3 not landed) ===" -ForegroundColor Cyan
$live = Invoke-Trpc -Procedure 'executor.submitTrade' -Input @{
    executionId  = "live-$now"
    channel      = 'my-live'
    origin       = 'USER'
    instrument   = 'NIFTY_50'
    direction    = 'BUY'
    quantity     = 75
    entryPrice   = 100
    stopLoss     = 90
    takeProfit   = 120
    orderType    = 'MARKET'
    productType  = 'INTRADAY'
    timestamp    = $now
}
"success = $($live.result.data.success)  status = $($live.result.data.status)"
"error   = $($live.result.data.error)"

Write-Host "`nDone." -ForegroundColor Green
