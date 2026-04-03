$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+?)\s*=\s*(.+?)\s*$') {
            Set-Item "env:$($Matches[1])" $Matches[2]
        }
    }
}
$KIMI_KEY = $env:KIMI_API_KEY
if (-not $KIMI_KEY) {
    Write-Host "[!] KIMI_API_KEY not set. Create a .env file with: KIMI_API_KEY=sk-xxxxx" -ForegroundColor Red
    exit 1
}
$PROXY_SCRIPT = Join-Path $PSScriptRoot "proxy.mjs"
$CLI_SCRIPT  = Join-Path $PSScriptRoot "package\cli.js"
$PROXY_PORT  = 4010

# --- Pre-flight: check Node.js ---
$nodeExe = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeExe) {
    Write-Host "[!] Node.js not found. Please install Node.js >= 18 from https://nodejs.org" -ForegroundColor Red
    exit 1
}
$nodeVer = (node -v) -replace '^v',''
if ([version]$nodeVer -lt [version]"18.0.0") {
    Write-Host "[!] Node.js $nodeVer is too old. Need >= 18.0.0" -ForegroundColor Red
    exit 1
}
Write-Host "[*] Node.js $nodeVer OK" -ForegroundColor Green

# --- Environment: disable all Anthropic-specific traffic ---
$env:KIMI_API_KEY = $KIMI_KEY
$env:DISABLE_TELEMETRY = "1"
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
$env:DISABLE_INSTALLATION_CHECKS = "1"
$env:CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = "1"
$env:DISABLE_AUTOUPDATER = "1"
$env:NODE_NO_WARNINGS = "1"

$proxyProc = Start-Process -FilePath "node" -ArgumentList "`"$PROXY_SCRIPT`" `"$KIMI_KEY`"" -PassThru -WindowStyle Hidden
Write-Host "[*] proxy started (PID $($proxyProc.Id)), waiting for ready..." -ForegroundColor Cyan

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:$PROXY_PORT" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        $ready = $true; break
    } catch {}
}
if (-not $ready) {
    Write-Host "[!] proxy failed to start" -ForegroundColor Red
    Stop-Process -Id $proxyProc.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "[*] proxy ready at http://localhost:$PROXY_PORT" -ForegroundColor Green

$env:ANTHROPIC_BASE_URL = "http://localhost:$PROXY_PORT"
$env:ANTHROPIC_API_KEY  = $KIMI_KEY

try {
    & node $CLI_SCRIPT --bare --dangerously-skip-permissions @args
} finally {
    Write-Host "`n[*] shutting down proxy (PID $($proxyProc.Id))..." -ForegroundColor Cyan
    Stop-Process -Id $proxyProc.Id -Force -ErrorAction SilentlyContinue
}
