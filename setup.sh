#!/bin/bash
# ── FB Group Monitor — VPS Setup Script ──────────────────────────────────────
# Run this once on a fresh Ubuntu 22.04 DigitalOcean droplet as root.
# Usage: bash setup.sh

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  FB Group Monitor — Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Node.js 20 ───────────────────────────────
echo "[1/6] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# ── System dependencies for Chromium ─────────
echo "[2/6] Installing system dependencies..."
apt-get install -y \
  libgbm-dev libasound2 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 libnss3 \
  libnspr4 libdbus-1-3 libatspi2.0-0 libx11-6 libx11-xcb1 \
  libxcb1 libxext6 libxss1 wget unzip git

# ── PM2 ──────────────────────────────────────
echo "[3/6] Installing PM2..."
npm install -g pm2

# ── App dependencies ──────────────────────────
echo "[4/6] Installing app dependencies..."
npm install

# ── Playwright Chromium ───────────────────────
echo "[5/6] Installing Playwright Chromium..."
npx playwright install chromium --with-deps

# ── Create .env from example ──────────────────
echo "[6/6] Setting up .env..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "⚠️  Edit .env with your API keys before starting:"
  echo "   nano .env"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo ""
echo "  1. Edit your config:"
echo "     nano .env"
echo ""
echo "  2. Upload Kameron's cookies:"
echo "     Place exported cookies.json at:  data/cookies.json"
echo ""
echo "  3. Seed existing posts (skip first-run notification flood):"
echo "     node src/monitor.js --seed"
echo ""
echo "  4. Start everything with PM2:"
echo "     pm2 start ecosystem.config.js"
echo "     pm2 save"
echo "     pm2 startup"
echo ""
echo "  5. Dashboard runs on port 3000"
echo "     Point your subdomain's A record at this server IP"
echo ""
