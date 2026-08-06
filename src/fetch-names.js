require('dotenv').config();
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const db = require('./db');

chromium.use(StealthPlugin());

const PARALLEL = 3;
const BAD_NAMES = new Set(['notifications', 'notification', '', 'see all', 'groups', 'feed', 'home']);

async function fetchAllNames() {
  const allGroups = db.getGroups();
  const groups = allGroups.filter(g => {
    const n = (g.name || '').trim().toLowerCase();
    return !n || BAD_NAMES.has(n) || n.length < 3;
  });

  db.addLog('info', `[NAME-FETCH] Starting — ${groups.length} of ${allGroups.length} groups need names`);

  const isWindows = process.platform === 'win32';
  const browser = await chromium.launch({
    headless: true,
    args: [
      ...(!isWindows ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  const cookiesPath = path.join(__dirname, '../data/cookies.json');
  if (fs.existsSync(cookiesPath)) {
    const raw = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
    const cookies = raw.map(c => ({
      name: c.name, value: c.value,
      domain: c.domain || '.facebook.com',
      path: c.path || '/',
      httpOnly: c.httpOnly || false,
      secure: c.secure || true,
      sameSite: ({ no_restriction: 'None', lax: 'Lax', strict: 'Strict' })[c.sameSite] || 'None',
    }));
    await context.addCookies(cookies);
  }

  let done = 0;
  let fixed = 0;

  for (let i = 0; i < groups.length; i += PARALLEL) {
    const batch = groups.slice(i, i + PARALLEL);

    await Promise.allSettled(batch.map(async (group) => {
      const page = await context.newPage();
      try {
        await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (page.url().includes('/login')) return; // session expired — skip

        await page.waitForTimeout(1500);

        let name = '';
        try {
          const h1 = await page.$('h1');
          if (h1) name = (await h1.innerText()).trim();
        } catch {}

        if (name && name.length > 2 && !BAD_NAMES.has(name.toLowerCase())) {
          db.updateGroupChecked(group.id, name);
          fixed++;
        }
      } catch {}
      finally {
        done++;
        await page.close().catch(() => {});
      }
    }));

    if (i % 30 === 0 || done >= groups.length) {
      db.addLog('info', `[NAME-FETCH] ${done}/${groups.length} done — ${fixed} names fixed`);
    }
  }

  await browser.close();
  db.addLog('info', `[NAME-FETCH] Complete — fixed ${fixed} of ${groups.length} groups`);
  process.stdout.write(JSON.stringify({ success: true, fixed, total: groups.length }) + '\n');
}

fetchAllNames().catch(e => {
  db.addLog('error', `[NAME-FETCH] Fatal: ${e.message}`);
  process.stdout.write(JSON.stringify({ success: false, error: e.message }) + '\n');
  process.exit(1);
});
