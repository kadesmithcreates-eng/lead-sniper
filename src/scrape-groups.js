require('dotenv').config();
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const db = require('./db');

chromium.use(StealthPlugin());

function buildProxy() {
  if (!process.env.IPROYAL_USERNAME) return {};
  return {
    proxy: {
      server: `http://${process.env.IPROYAL_PROXY_HOST || 'geo.iproyal.com'}:${process.env.IPROYAL_PROXY_PORT || '12321'}`,
      username: process.env.IPROYAL_USERNAME,
      password: process.env.IPROYAL_PASSWORD
    }
  };
}

const SKIP_SLUGS = new Set(['feed', 'discover', 'joins', 'search', 'creates', 'notifications', 'membership_questions', 'buy']);
const SKIP_DEEP  = new Set(['posts', 'members', 'media', 'files', 'events', 'about', 'permalink', 'photos']);

async function scrapeGroups() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ...buildProxy()
  });

  // Use a mobile user agent — m.facebook.com renders groups as a simple flat list
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // Load session cookies
  const cookiesPath = path.join(__dirname, '../data/cookies.json');
  if (fs.existsSync(cookiesPath)) {
    const raw = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
    const cookies = raw.map(c => ({
      name: c.name, value: c.value,
      domain: c.domain || '.facebook.com',
      path: c.path || '/',
      httpOnly: c.httpOnly || false,
      secure: c.secure || true,
      sameSite: ({no_restriction:'None',lax:'Lax',strict:'Strict'})[c.sameSite] || 'None',
    }));
    await context.addCookies(cookies);
  }

  const page = await context.newPage();
  let found = [];

  function extractAnchors(anchors) {
    const skipSlugs = new Set(['feed','discover','joins','search','creates','notifications','membership_questions','buy']);
    const skipDeep  = new Set(['posts','members','media','files','events','about','permalink','photos']);
    const results = [];
    for (const a of anchors) {
      try {
        const href = a.href;
        if (!href) continue;
        const url = new URL(href);
        if (!['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(url.hostname)) continue;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length < 2 || parts[0] !== 'groups') continue;
        const groupSlug = parts[1];
        if (skipSlugs.has(groupSlug)) continue;
        if (parts.length > 2 && skipDeep.has(parts[2])) continue;
        const groupUrl = `https://www.facebook.com/groups/${groupSlug}/`;
        const name = (a.textContent || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
        results.push({ url: groupUrl, name });
      } catch {}
    }
    return results;
  }

  try {
    await page.goto('https://m.facebook.com/groups/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForTimeout(3000);

    // Collect groups on every scroll pass — Facebook uses a virtualized list
    // so groups disappear from DOM as you scroll. Must harvest on every pass.
    const allGroups = new Map();
    let lastSize = 0;
    let stalePasses = 0;

    for (let i = 0; i < 80; i++) {
      // Harvest all currently visible group links
      const visible = await page.$$eval('a[href*="/groups/"]', (anchors) => {
        const skipSlugs = new Set(['feed','discover','joins','search','creates','notifications','membership_questions','buy']);
        const skipDeep  = new Set(['posts','members','media','files','events','about','permalink','photos']);
        const results = [];
        for (const a of anchors) {
          try {
            const href = a.href;
            if (!href) continue;
            const url = new URL(href);
            if (!['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(url.hostname)) continue;
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts.length < 2 || parts[0] !== 'groups') continue;
            const groupSlug = parts[1];
            if (skipSlugs.has(groupSlug)) continue;
            if (parts.length > 2 && skipDeep.has(parts[2])) continue;
            const groupUrl = `https://www.facebook.com/groups/${groupSlug}/`;
            const name = (a.textContent || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
            results.push({ url: groupUrl, name });
          } catch {}
        }
        return results;
      });

      for (const g of visible) {
        if (!allGroups.has(g.url)) allGroups.set(g.url, g);
      }

      // Scroll every element with computed overflow-y scroll/auto, plus window
      await page.evaluate(() => {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          try {
            const s = window.getComputedStyle(el);
            if ((s.overflowY === 'scroll' || s.overflowY === 'auto') && el.scrollHeight > el.clientHeight + 100) {
              el.scrollBy(0, 1200);
            }
          } catch {}
        }
        window.scrollBy(0, 1200);
      });

      await page.waitForTimeout(1800 + Math.random() * 700);

      const newSize = allGroups.size;
      if (newSize === lastSize) {
        stalePasses++;
        if (stalePasses >= 8) break;
      } else {
        stalePasses = 0;
        lastSize = newSize;
      }
    }

    found = [...allGroups.values()];

  } finally {
    await page.close();
    await browser.close();
  }

  // Bulk insert into database
  let added = 0;
  let skipped = 0;
  for (const g of found) {
    const r = db.addGroup(g.url, g.name);
    if (r.success) added++;
    else skipped++;
  }

  const result = { success: true, found: found.length, added, skipped };
  // Write JSON result to stdout so server.js can parse it
  process.stdout.write(JSON.stringify(result) + '\n');
  return result;
}

scrapeGroups().catch(e => {
  process.stdout.write(JSON.stringify({ success: false, error: e.message }) + '\n');
  process.exit(1);
});
