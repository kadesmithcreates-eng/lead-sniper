require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Telegram helpers ──────────────────────────────────
async function tgSend(text, extra = {}) {
  if (!TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text, parse_mode: 'HTML', ...extra },
      { timeout: 10000 }
    );
  } catch (e) { console.error('tgSend failed:', e.message); }
}

async function tgAnswer(callbackQueryId, text = '') {
  if (!TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`,
      { callback_query_id: callbackQueryId, text },
      { timeout: 8000 }
    );
  } catch {}
}

// ── Chrome cookie extraction ──────────────────────────
function getChromeCookiePath() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default');
  const network = path.join(base, 'Network', 'Cookies');
  return fs.existsSync(network) ? network : path.join(base, 'Cookies');
}

function getLocalStatePath() {
  return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State');
}

async function getDPAPIKey(encryptedKey) {
  const tmpIn  = path.join(os.tmpdir(), `dpapi-in-${Date.now()}.bin`);
  const tmpOut = path.join(os.tmpdir(), `dpapi-out-${Date.now()}.bin`);
  fs.writeFileSync(tmpIn, encryptedKey);

  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Security; ` +
      `$enc = [System.IO.File]::ReadAllBytes('${tmpIn}'); ` +
      `$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
      `[System.IO.File]::WriteAllBytes('${tmpOut}', $dec)`
    ], { windowsHide: true });

    ps.on('close', code => {
      try { fs.unlinkSync(tmpIn); } catch {}
      if (code !== 0) return reject(new Error('DPAPI decryption failed (code ' + code + ')'));
      const key = fs.readFileSync(tmpOut);
      try { fs.unlinkSync(tmpOut); } catch {}
      resolve(key);
    });
    ps.on('error', reject);
  });
}

function decryptValue(key, encryptedValue) {
  try {
    const buf = Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(encryptedValue);
    const prefix = buf.slice(0, 3).toString('ascii');
    if (prefix === 'v10' || prefix === 'v11') {
      const iv      = buf.slice(3, 15);
      const authTag = buf.slice(buf.length - 16);
      const payload = buf.slice(15, buf.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      return decipher.update(payload, null, 'utf8') + decipher.final('utf8');
    }
  } catch {}
  return null;
}

async function extractFacebookCookies() {
  const localStatePath = getLocalStatePath();
  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encKeyRaw = Buffer.from(localState.os_crypt.encrypted_key, 'base64').slice(5); // strip DPAPI prefix
  const aesKey = await getDPAPIKey(encKeyRaw);

  const cookieFile = getChromeCookiePath();
  const tmpDb = path.join(os.tmpdir(), `chrome-cookies-${Date.now()}.db`);
  fs.copyFileSync(cookieFile, tmpDb); // copy to avoid SQLite lock

  let cookies = [];
  try {
    const db = new DatabaseSync(tmpDb);
    const rows = db.prepare(
      `SELECT name, encrypted_value, host_key, path, is_httponly, is_secure, samesite
       FROM cookies WHERE host_key LIKE '%facebook.com'`
    ).all();
    db.close();

    for (const row of rows) {
      const value = decryptValue(aesKey, row.encrypted_value);
      if (!value) continue;
      cookies.push({
        name:     row.name,
        value,
        domain:   row.host_key,
        path:     row.path,
        httpOnly: !!row.is_httponly,
        secure:   !!row.is_secure,
        sameSite: ['no_restriction', 'lax', 'strict'][row.samesite] || 'no_restriction',
      });
    }
  } finally {
    try { fs.unlinkSync(tmpDb); } catch {}
  }

  return cookies;
}

// ── Refresh handler ───────────────────────────────────
async function handleRefresh(callbackQueryId) {
  await tgAnswer(callbackQueryId, 'Reading cookies from Chrome...');
  await tgSend('⏳ Reading Facebook cookies from Chrome — one moment...');

  try {
    const cookies = await extractFacebookCookies();
    if (cookies.length === 0) {
      await tgSend('❌ No Facebook cookies found in Chrome.\n\nMake sure you\'re logged into Facebook in Chrome on the mini PC, then try again.');
      return;
    }

    const cookiesPath = path.join(__dirname, '../data/cookies.json');
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));

    // Restart monitor
    await new Promise(resolve => exec('pm2 restart fb-monitor', () => resolve()));

    await tgSend(`✅ Done! ${cookies.length} Facebook cookies saved and monitor restarted.\n\nLead Sniper is back online.`);
  } catch (e) {
    console.error('Cookie refresh error:', e);
    await tgSend(`❌ Cookie refresh failed: ${e.message}\n\nYou'll need to paste cookies manually in the dashboard.`);
  }
}

// ── Telegram long-poll loop ───────────────────────────
let offset = 0;

async function poll() {
  try {
    const r = await axios.get(
      `https://api.telegram.org/bot${TOKEN}/getUpdates`,
      { params: { offset, timeout: 25, allowed_updates: ['callback_query'] }, timeout: 30000 }
    );
    for (const update of (r.data.result || [])) {
      offset = update.update_id + 1;
      if (update.callback_query?.data === 'refresh_cookies') {
        handleRefresh(update.callback_query.id).catch(e => console.error('handleRefresh:', e));
      }
    }
  } catch (e) {
    if (!e.message?.includes('timeout')) console.error('Poll error:', e.message);
    await sleep(5000);
  }
}

async function main() {
  if (!TOKEN || !CHAT_ID) {
    console.log('No Telegram credentials — cookie bot disabled');
    return;
  }
  console.log('Cookie bot started — listening for Telegram callbacks');
  while (true) await poll();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
