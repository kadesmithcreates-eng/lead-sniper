# Lead Sniper — Windows Setup Script
# Run this in PowerShell as Administrator on Jacob's mini PC
# Right-click PowerShell -> "Run as Administrator"

$ErrorActionPreference = "Stop"
$installDir = "C:\lead-sniper"

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  LEAD SNIPER — Windows Setup" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Check / Install Node.js ──────────────────────────────────────────
Write-Host "[1/7] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version 2>$null
    Write-Host "      Node.js already installed: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "      Node.js not found — installing via winget..." -ForegroundColor Yellow
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-Host "      Node.js installed." -ForegroundColor Green
}

# ── Step 2: Create install directory ─────────────────────────────────────────
Write-Host "[2/7] Setting up C:\lead-sniper directory..." -ForegroundColor Yellow
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}
New-Item -ItemType Directory -Path "$installDir\data" -Force | Out-Null
Write-Host "      Done." -ForegroundColor Green

# ── Step 3: Copy files from RDP shared drive ──────────────────────────────────
Write-Host "[3/7] Copying Lead Sniper files..." -ForegroundColor Yellow
$source = "\\tsclient\C\Users\Kade\facebook-monitor"
if (Test-Path $source) {
    Copy-Item -Path "$source\*" -Destination $installDir -Recurse -Force
    Write-Host "      Files copied from your PC via RDP drive." -ForegroundColor Green
} else {
    Write-Host "      WARNING: Could not find $source" -ForegroundColor Red
    Write-Host "      Make sure 'Local disk (C:)' is shared in Remote Desktop settings." -ForegroundColor Red
    Write-Host "      Or manually copy the facebook-monitor folder to C:\lead-sniper" -ForegroundColor Red
    Read-Host "Press Enter once you've copied the files manually, then continue"
}

# ── Step 4: Install npm dependencies ─────────────────────────────────────────
Write-Host "[4/7] Installing npm packages..." -ForegroundColor Yellow
Set-Location $installDir
npm install --legacy-peer-deps
if ($LASTEXITCODE -ne 0) {
    Write-Host "      npm install failed. Trying with --force..." -ForegroundColor Yellow
    npm install --force
}
Write-Host "      Packages installed." -ForegroundColor Green

# ── Step 5: Install Playwright Chromium ──────────────────────────────────────
Write-Host "[5/7] Installing Playwright Chromium browser..." -ForegroundColor Yellow
npx playwright install chromium
Write-Host "      Chromium installed." -ForegroundColor Green

# ── Step 6: Install PM2 ───────────────────────────────────────────────────────
Write-Host "[6/7] Installing PM2 process manager..." -ForegroundColor Yellow
npm install -g pm2
npm install -g pm2-windows-startup
pm2-startup install
Write-Host "      PM2 installed and configured for auto-start." -ForegroundColor Green

# ── Step 7: Create .env file ──────────────────────────────────────────────────
Write-Host "[7/7] Creating .env configuration..." -ForegroundColor Yellow

$envContent = @"
# ── Gemini AI ──────────────────────────────────────────────────────────────────
GEMINI_API_KEY=PASTE_FROM_VPS

# ── Telegram Notifications ─────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=PASTE_FROM_VPS
TELEGRAM_CHAT_ID=PASTE_FROM_VPS

# ── Discord Notifications (optional) ─────────────────────────────────────────
DISCORD_WEBHOOK_URL=PASTE_FROM_VPS

# ── Dashboard ─────────────────────────────────────────────────────────────────
DASHBOARD_PORT=3000
DASHBOARD_PASSWORD=PASTE_FROM_VPS
DASHBOARD_URL=http://TAILSCALE_IP:3000
JWT_SECRET=PASTE_FROM_VPS

# NOTE: No proxy settings — running on Jacob's home IP, no proxy needed
"@

# Only write if .env doesn't already exist
if (-not (Test-Path "$installDir\.env")) {
    Set-Content -Path "$installDir\.env" -Value $envContent -Encoding utf8
    Write-Host "      .env created — YOU MUST FILL IN THE VALUES BEFORE STARTING!" -ForegroundColor Red
} else {
    Write-Host "      .env already exists — skipping (edit manually if needed)." -ForegroundColor Yellow
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Yellow
Write-Host "  1. Edit C:\lead-sniper\.env with real credentials" -ForegroundColor White
Write-Host "  2. Get Jacob to export cookies from Chrome (Cookie-Editor)" -ForegroundColor White
Write-Host "  3. Save cookies.json to C:\lead-sniper\data\cookies.json" -ForegroundColor White
Write-Host "  4. Run: cd C:\lead-sniper && pm2 start ecosystem.config.js" -ForegroundColor White
Write-Host "  5. Run: pm2 save" -ForegroundColor White
Write-Host "  6. Open dashboard and click 'Import All Groups'" -ForegroundColor White
Write-Host ""
