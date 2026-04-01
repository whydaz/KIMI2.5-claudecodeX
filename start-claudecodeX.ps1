$KIMI_KEY = "your kimi api key"
$PROXY_SCRIPT = Join-Path $PSScriptRoot "proxy.mjs"
$PROXY_PORT = 4010

$env:KIMI_API_KEY = $KIMI_KEY
$proxyProc = Start-Process -FilePath "node" -ArgumentList "`"$PROXY_SCRIPT`"" -PassThru -WindowStyle Hidden
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
    & claudecodeX @args
} finally {
    Write-Host "`n[*] shutting down proxy (PID $($proxyProc.Id))..." -ForegroundColor Cyan
    Stop-Process -Id $proxyProc.Id -Force -ErrorAction SilentlyContinue
}
