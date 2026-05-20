#requires -Version 5.1
<#
  _emit-lifecycle.ps1 -- Append one JSON line to logs\lubas-lifecycle.log
                         AND push the event to Telegram via yow-partha
                         (if YOW_PARTHA_BOT_TOKEN + YOW_PARTHA_CHAT_ID
                         are set in env or root .env).

  Single source of truth for "did Lubas come up / shut down today" without
  needing to eyeball 4 cmd windows. The file is NDJSON (one JSON object
  per line) so downstream tools like jq / pandas read_json(lines=True)
  can consume it directly.

  Usage from batch:
      powershell -NoProfile -ExecutionPolicy Bypass `
                 -File "%~dp0_emit-lifecycle.ps1" `
                 -Event start -Result ok -Process api

  Usage from PowerShell (in-process, no new powershell.exe):
      & (Join-Path $PSScriptRoot '_emit-lifecycle.ps1') `
        -Event stop -Result ok -Killed 5 -Survivors 0

  Telegram push is fire-and-forget. If the credentials aren't set or the
  POST fails, the lifecycle log is still written. Never blocks the caller.
#>
param(
    [Parameter(Mandatory=$true)] [string] $Event,
    [Parameter(Mandatory=$true)] [string] $Result,
    [string] $Process = '',
    [string] $Detail  = '',
    [int]    $Code    = -2147483648,  # sentinel "not set"
    [int]    $TfaCount  = -1,
    [int]    $Killed    = -1,
    [int]    $Survivors = -1
)

$ErrorActionPreference = 'Continue'

# ── Resolve paths ────────────────────────────────────────────────────────
$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir  = Join-Path $rootDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'lubas-lifecycle.log'

# ── Write NDJSON line (unchanged from prior contract) ────────────────────
$obj = [ordered]@{
    ts     = (Get-Date).ToString('o')
    event  = $Event
    result = $Result
}
if ($Process) { $obj.process = $Process }
if ($Detail)  { $obj.detail  = $Detail }
if ($Code -ne -2147483648) { $obj.code = $Code }
if ($TfaCount  -ge 0) { $obj.tfa_count = $TfaCount }
if ($Killed    -ge 0) { $obj.killed    = $Killed }
if ($Survivors -ge 0) { $obj.survivors = $Survivors }

$line = $obj | ConvertTo-Json -Compress
# UTF-8 without BOM -- downstream grep / jq don't trip on the BOM.
[System.IO.File]::AppendAllText($logFile, "$line`n", [System.Text.Encoding]::UTF8)

# ── Telegram push (silent no-op if creds missing) ────────────────────────
# Look up token + chat id from env first; fall back to parsing root .env.
$token  = $env:YOW_PARTHA_BOT_TOKEN
$chatId = $env:YOW_PARTHA_CHAT_ID

if (-not $token -or -not $chatId) {
    $envFile = Join-Path $rootDir '.env'
    if (Test-Path $envFile) {
        foreach ($l in (Get-Content $envFile -ErrorAction SilentlyContinue)) {
            if ($l -match '^\s*YOW_PARTHA_BOT_TOKEN\s*=\s*(.+?)\s*$' -and -not $token) {
                $token = $matches[1].Trim('"').Trim("'")
            }
            elseif ($l -match '^\s*YOW_PARTHA_CHAT_ID\s*=\s*(.+?)\s*$' -and -not $chatId) {
                $chatId = $matches[1].Trim('"').Trim("'")
            }
        }
    }
}

if (-not $token -or -not $chatId) { return }  # creds missing → silent no-op

# ── Prettify ISO dates inside $Detail (YYYY-MM-DD → Mon Nth [YYYY]) ──────
# Year omitted when it matches the current calendar year. The NDJSON log
# already has the raw ISO so forensics are unaffected.
function _OrdinalSuffix([int] $n) {
    if ($n -ge 11 -and $n -le 13) { return 'th' }
    switch ($n % 10) {
        1 { 'st'; break }
        2 { 'nd'; break }
        3 { 'rd'; break }
        default { 'th' }
    }
}
function _PrettyDate([string] $iso) {
    try {
        $d = [datetime]::ParseExact($iso, 'yyyy-MM-dd', $null)
    } catch {
        return $iso  # unparseable -> leave raw, never crash the pipeline
    }
    $mon = $d.ToString('MMM', [Globalization.CultureInfo]::InvariantCulture)
    $day = $d.Day
    $ord = _OrdinalSuffix $day
    if ($d.Year -eq (Get-Date).Year) {
        return "$mon $day$ord"
    } else {
        return "$mon $day$ord $($d.Year)"
    }
}
if ($Detail) {
    $Detail = [regex]::Replace($Detail, '\b(\d{4})-(\d{2})-(\d{2})\b', { param($m) _PrettyDate $m.Value })
}

# Severity glyph based on the result. Built from Unicode codepoints so the
# .ps1 file stays ASCII-safe regardless of how PowerShell loads it; the
# emoji only need to render in Telegram, never in the cmd console.
#   green circle (started), check (ok/completed), red circle (error),
#   warning sign (warning), octagonal stop (stopped/terminated).
$icon = switch -Regex ($Result.ToLower()) {
    '^(start|starting)$'         { [char]::ConvertFromUtf32(0x1F7E2); break }   # green circle
    '^(ok|success|completed)$'   { [char]::ConvertFromUtf32(0x2705);  break }   # check
    '^(error|fail|failed)$'      { [char]::ConvertFromUtf32(0x1F534); break }   # red circle
    '^(warn|warning)$'           { [char]::ConvertFromUtf32(0x26A0) + [char]::ConvertFromUtf32(0xFE0F); break }  # warning + variation selector
    '^(terminated|killed|stopped|stop)$' { [char]::ConvertFromUtf32(0x1F6D1); break }  # octagonal stop
    default                      { [char]::ConvertFromUtf32(0x1F535) }          # blue circle (info)
}

# Plain-English message shape (locked 2026-05-19, single-line):
#   <emoji> <plain-noun> <plain-verb>[ <connector> <detail>]
# Connector chosen per verb to read as natural English (Option B from the
# 2026-05-19 chat samples):
#   started      -> " for "        (with preposition guard, see below)
#   ok/completed -> ", "
#   error        -> " because "
#   warning      -> ": "
#   stopped      -> ". "
# No system prefix, no timestamp, no bot-name marker, no event/result
# word-pair, no hashtags, no bold, no line breaks, no `code=N` jargon
# (raw code stays in the NDJSON log for forensics).
function _ConnectorFor([string] $r, [string] $detail) {
    $rl = $r.ToLower()
    # Preposition guard: if the detail already begins with a connector word
    # ("up to Dec 31st", "since 2026-04-01"), skip our own connector word
    # so we don't produce "started for up to Dec 31st".
    $detailLower = $detail.ToLower().TrimStart()
    $hasOwnPrep = ($detailLower -like 'up to *')   -or
                  ($detailLower -like 'since *')   -or
                  ($detailLower -like 'from *')    -or
                  ($detailLower -like 'after *')   -or
                  ($detailLower -like 'before *')  -or
                  ($detailLower -like 'until *')   -or
                  ($detailLower -like 'for *')
    switch -Regex ($rl) {
        '^(start|starting)$'                 { if ($hasOwnPrep) { return ' ' } else { return ' for ' } }
        '^(ok|success|completed)$'           { return ', ' }
        '^(error|fail|failed)$'              { return ' because ' }
        '^(warn|warning)$'                   { return ': ' }
        '^(stopped|stop|terminated|killed)$' { return '. ' }
        default                              { return ' ' + [char]0x2014 + ' ' }   # em-dash fallback
    }
}

# Process name → human noun. Keep additions here in lockstep with the
# bats' -Process values; an unknown key falls back to the raw name.
function _NounFor([string] $p) {
    switch -Regex ($p) {
        '^api$'                       { return 'API server' }
        '^tfa-nifty50$'               { return 'NIFTY 50 recorder' }
        '^tfa-banknifty$'             { return 'Bank Nifty recorder' }
        '^tfa-crudeoil$'              { return 'Crude Oil recorder' }
        '^tfa-naturalgas$'            { return 'Natural Gas recorder' }
        '^sea-nifty50$'               { return 'NIFTY 50 signal engine' }
        '^sea-banknifty$'             { return 'Bank Nifty signal engine' }
        '^sea-crudeoil$'              { return 'Crude Oil signal engine' }
        '^sea-naturalgas$'            { return 'Natural Gas signal engine' }
        '^replay-nifty50$'            { return 'NIFTY 50 replay' }
        '^replay-banknifty$'          { return 'Bank Nifty replay' }
        '^replay-crudeoil$'           { return 'Crude Oil replay' }
        '^replay-naturalgas$'         { return 'Natural Gas replay' }
        '^train-nifty50$'             { return 'NIFTY 50 model training' }
        '^train-banknifty$'           { return 'Bank Nifty model training' }
        '^train-crudeoil$'            { return 'Crude Oil model training' }
        '^train-naturalgas$'          { return 'Natural Gas model training' }
        '^train-auto-nifty50$'        { return 'NIFTY 50 auto-training' }
        '^train-auto-banknifty$'      { return 'Bank Nifty auto-training' }
        '^train-auto-crudeoil$'       { return 'Crude Oil auto-training' }
        '^train-auto-naturalgas$'     { return 'Natural Gas auto-training' }
        '^start-all$'                 { return 'All systems' }
        '^stop-all$'                  { return 'All systems' }
        '^yow-partha$'                { return 'yow-partha bot' }
        default                       { return $p }
    }
}

# Result → human verb. Stays close to natural English; "crashed" is
# reserved for an unexpected stop+error on a long-running process.
function _VerbFor([string] $r, [string] $p) {
    $isLongRunning = $p -match '^(api|tfa-|sea-|start-all)'
    switch -Regex ($r.ToLower()) {
        '^(start|starting)$'         { return 'started' }
        '^ok$'                       { return 'stopped cleanly' }
        '^success$'                  { return 'succeeded' }
        '^completed$'                { return 'finished' }
        '^(error|fail|failed)$'      {
            if ($isLongRunning) { return 'crashed' } else { return 'hit an error' }
        }
        '^(warn|warning)$'           { return 'sent a warning' }
        '^terminated$'               { return 'was terminated' }
        '^killed$'                   { return 'was killed' }
        '^(stopped|stop)$'           { return 'stopped' }
        default                      { return $r.ToLower() }
    }
}

$noun = _NounFor $Process
$verb = _VerbFor $Result $Process

# "Heads up from <X>" reads more naturally than "<X> sent a warning"
if ($verb -eq 'sent a warning') {
    $msg = "$icon Heads up from $noun"
} else {
    $msg = "$icon $noun $verb"
}
if ($Detail) {
    $connector = _ConnectorFor $Result $Detail
    $msg += "$connector$Detail"
}

try {
    # Inline-keyboard buttons. Only attached when $Process matches one of
    # the bot's known targets (api / tfa-* / replay-* / train-*). Other
    # processes (start-all, stop-all, train-auto-*, yow-partha) get no
    # buttons because no bot action makes sense for them. Buttons only
    # fire if yow-partha listener is running; otherwise they're cosmetic.
    $knownTargets = @(
        'api',
        'tfa-nifty50', 'tfa-banknifty', 'tfa-crudeoil', 'tfa-naturalgas',
        'replay-nifty50', 'replay-banknifty', 'replay-crudeoil', 'replay-naturalgas',
        'train-nifty50', 'train-banknifty', 'train-crudeoil', 'train-naturalgas'
    )
    $kb = $null
    if ($knownTargets -contains $Process) {
        $rl = $Result.ToLower()
        # Buttons only on error + warning. Start and finish events are
        # informational — no action button needed (user picked 2026-05-19).
        if ($rl -match '^(error|fail|failed)$') {
            $kb = @(
                ,@(
                    @{ text = [char]::ConvertFromUtf32(0x1F440) + ' See error'; callback_data = "logs:$Process" },
                    @{ text = [char]::ConvertFromUtf32(0x21BB) + ' Restart'; callback_data = "restart:$Process" }
                ),
                ,@(
                    @{ text = [char]::ConvertFromUtf32(0x23F9) + ' Stop'; callback_data = "stop:$Process" }
                )
            )
        } elseif ($rl -match '^(warn|warning)$') {
            $kb = @(,@(
                @{ text = [char]::ConvertFromUtf32(0x1F440) + ' See logs'; callback_data = "logs:$Process" },
                @{ text = [char]::ConvertFromUtf32(0x2713) + ' Ack'; callback_data = 'home' }
            ))
        }
    }

    $payload = @{ chat_id = $chatId; text = $msg }
    if ($kb) { $payload.reply_markup = @{ inline_keyboard = $kb } }

    # Build body as UTF-8 bytes so emoji + non-ASCII detail strings survive
    # the HTTP round-trip. Invoke-RestMethod's default -Body handling on
    # PS 5.1 can fall back to ASCII and mangle the codepoints. Depth 6
    # needed because of nested inline_keyboard array-of-array-of-hash.
    $bodyJson  = $payload | ConvertTo-Json -Compress -Depth 6
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)
    # 20s timeout — 5s was too tight on residential connections and silently
    # dropped pushes when api.telegram.org was slow to respond. Verified
    # 2026-05-19: 5s consistently timed out, 20s succeeded.
    Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/sendMessage" `
                      -Method Post `
                      -ContentType 'application/json; charset=utf-8' `
                      -Body $bodyBytes `
                      -TimeoutSec 20 | Out-Null
} catch {
    # Never break the caller; log failure to the same NDJSON file for forensics.
    $fail = [ordered]@{
        ts     = (Get-Date).ToString('o')
        event  = 'telegram_push_failed'
        result = 'error'
        detail = $_.Exception.Message
    } | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText($logFile, "$fail`n", [System.Text.Encoding]::UTF8)
}
