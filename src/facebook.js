require('dotenv').config();
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

chromium.use(StealthPlugin());

// Persistent context IS the browser — no separate browser object needed.
// Saves cookies, localStorage, history, and full browser state between sessions.
let context = null;
const USER_DATA_DIR = path.join(__dirname, '../data/browser-profile');

// Desktop UAs — we're using a real desktop Chromium, so match it
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

function buildProxyConfig() {
  if (!process.env.IPROYAL_USERNAME) return {};
  return {
    proxy: {
      server: `http://${process.env.IPROYAL_PROXY_HOST || 'geo.iproyal.com'}:${process.env.IPROYAL_PROXY_PORT || '12321'}`,
      username: process.env.IPROYAL_USERNAME,
      password: process.env.IPROYAL_PASSWORD,
    },
  };
}

async function initBrowser() {
  if (context) await closeBrowser();

  // Check BEFORE launch — launchPersistentContext creates the profile dir itself,
  // so checking after launch always sees the file and skips cookie import.
  const isFirstRun = !fs.existsSync(path.join(USER_DATA_DIR, 'Default', 'Preferences'));

  // Desktop viewport — matches actual Chromium capabilities
  const width  = 1280 + Math.floor(Math.random() * 160);
  const height = 768  + Math.floor(Math.random() * 132);
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--no-default-browser-check',
      '--disable-notifications',
      `--window-size=${width},${height}`,
    ],
    userAgent: ua,
    viewport: { width, height },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    ...buildProxyConfig(),
  });

  if (isFirstRun) {
    const cookiesPath = path.join(__dirname, '../data/cookies.json');
    if (fs.existsSync(cookiesPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        const cookies = raw.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain || '.facebook.com',
          path: c.path || '/',
          httpOnly: c.httpOnly || false,
          secure: c.secure !== false,
          sameSite: ({ no_restriction: 'None', lax: 'Lax', strict: 'Strict' })[c.sameSite] || 'None',
        }));
        await context.addCookies(cookies);
        console.log('First run: loaded cookies from cookies.json');
      } catch (e) {
        console.error('Failed to load cookies:', e.message);
      }
    } else {
      console.warn('No cookies.json found — place exported Facebook cookies at data/cookies.json');
    }
  }
}

async function closeBrowser() {
  try { if (context) await context.close(); } catch {}
  context = null;
}

// Realistic human interaction: bezier-curved mouse movement + mouse-wheel scrolling.
// Mouse wheel is harder to distinguish from a real user than window.scrollBy().
async function humanInteract(page) {
  // Move cursor around in natural arcs
  const moves = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < moves; i++) {
    const x = 40 + Math.random() * (290);
    const y = 80 + Math.random() * 500;
    await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 18) });
    await page.waitForTimeout(120 + Math.random() * 700);
  }

  // Scroll with mouse wheel in chunks like a human reading
  const scrolls = 3 + Math.floor(Math.random() * 4);
  for (let i = 0; i < scrolls; i++) {
    const amount = 100 + Math.random() * 380;
    await page.mouse.wheel(0, amount);
    await page.waitForTimeout(600 + Math.random() * 1600);
    // Occasionally scroll back up a bit — humans re-read things
    if (Math.random() < 0.35) {
      await page.mouse.wheel(0, -(40 + Math.random() * 130));
      await page.waitForTimeout(350 + Math.random() * 700);
    }
  }
}

function getPostFingerprint(url, text) {
  if (url && (url.includes('/posts/') || url.includes('story_fbid') || url.includes('permalink'))) {
    return url.split('?')[0]; // strip query params
  }
  // Fallback: first 150 chars of text (dedupes reposts/shares of same content)
  return 'txt:' + text.slice(0, 150).replace(/\s+/g, ' ').trim();
}

async function checkGroup(group, keywords, seedMode = false) {
  if (!context) throw new Error('Browser not initialized');

  const page = await context.newPage();
  const results = [];

  try {
    await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Detect session expiry — Facebook redirects to login page when cookies are dead
    if (page.url().includes('/login')) {
      throw new Error('SESSION_EXPIRED');
    }

    // Bail if redirected away from a group page (e.g. to Messenger, feed, profile)
    if (!page.url().includes('/groups/')) {
      await page.close();
      return { results: [], groupName: group.name || group.url };
    }

    // Human-like pause after page load, then interact naturally
    await page.waitForTimeout(1500 + Math.random() * 2000);
    await humanInteract(page);
    await page.waitForTimeout(500 + Math.random() * 800);

    // Try to grab group name
    let groupName = group.name || group.url;
    try {
      const h1 = await page.$('h1');
      if (h1) {
        const t = (await h1.innerText()).trim();
        if (t) groupName = t;
      }
    } catch {}

    // Find post articles — role="article" is the most stable Facebook selector
    const articles = await page.$$('div[role="article"]');

    for (const article of articles) {
      try {
        const rawText = await article.innerText();
        if (!rawText || rawText.length < 15) continue;

        // Try to get post timestamp — used for age filtering and passed to AI
        let postTs = null;
        try {
          postTs = await article.evaluate(el => {
            const abbr = el.querySelector('abbr[data-utime]');
            if (abbr) return parseInt(abbr.getAttribute('data-utime'), 10) * 1000;
            const time = el.querySelector('time[datetime]');
            if (time) return new Date(time.getAttribute('datetime')).getTime();
            return null;
          });
          if (postTs !== null && postTs < Date.now() - 7 * 24 * 60 * 60 * 1000) continue;
        } catch {}

        // Find a post URL — skip articles with no post permalink (filters messages/notifications)
        let postUrl = null;
        try {
          const links = await article.$$('a[href]');
          for (const link of links) {
            const href = await link.getAttribute('href');
            if (!href) continue;
            if (href.includes('/posts/') || href.includes('story_fbid') || href.includes('/permalink/')) {
              postUrl = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
              break;
            }
          }
        } catch {}
        if (!postUrl) continue; // not a feed post (message, notification, sidebar card)

        const fingerprint = getPostFingerprint(postUrl, rawText);

        // In seed mode — just mark everything as seen, don't notify
        if (seedMode) {
          results.push({ fingerprint, seed: true });
          continue;
        }

        // Keyword match (case-insensitive)
        const lower = rawText.toLowerCase();
        const matched = keywords.filter(k => lower.includes(k.keyword.toLowerCase()));
        if (matched.length === 0) continue;

        results.push({
          fingerprint,
          postUrl,
          postText: rawText.slice(0, 800),
          matchedKeywords: matched,
          groupName,
          postTs,
          seed: false
        });
      } catch {}
    }

    return { results, groupName };
  } finally {
    await page.close();
  }
}

async function takeDebugScreenshot() {
  const screenshotPath = path.join(__dirname, '../data', `debug-${Date.now()}.png`);
  try {
    const page = await context.newPage();
    await page.goto('https://www.facebook.com', { timeout: 20000 });
    await page.screenshot({ path: screenshotPath });
    await page.close();
    return screenshotPath;
  } catch (e) {
    return null;
  }
}

async function checkFeed(keywords, seedMode = false) {
  if (!context) throw new Error('Browser not initialized');

  let page;
  try {
    page = await context.newPage();
  } catch {
    context = null;
    throw new Error('Browser not initialized');
  }
  const results = [];

  try {
    // Use www.facebook.com — mbasic gets redirected to the full site for real Chromium browsers.
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });

    const landedUrl = page.url();
    console.log('[checkFeed] landed on:', landedUrl);
    if (landedUrl.includes('/login') || landedUrl.includes('login.php')) throw new Error('SESSION_EXPIRED');

    // Poll until React has rendered real feed content (body > 5000 chars or 3+ articles)
    // Timeout of 40s — slow PCs may need extra time
    try {
      await page.waitForFunction(
        () => document.body.innerText.length > 5000 || document.querySelectorAll('div[role="article"]').length > 2,
        { timeout: 40000, polling: 1000 }
      );
    } catch {
      console.log('[checkFeed] waitForFunction timed out — scraping whatever is loaded');
    }

    // Diagnostic: log how many of each selector exist so we know what state the page is in
    const diag = await page.evaluate(() => ({
      articles:  document.querySelectorAll('div[role="article"]').length,
      bodyLen:   (document.body?.innerText || '').length,
    }));
    console.log('[checkFeed] diag:', JSON.stringify(diag));

    const cutoff = Date.now() - 8 * 60 * 60 * 1000;

    // Set up a MutationObserver BEFORE scrolling so we capture posts as they
    // enter the DOM during scroll — Facebook's virtual list removes them again
    // immediately, so querying after scroll always sees almost nothing.
    await page.evaluate((cutoffMs) => {
      window.__capturedPosts = [];
      window.__seenTexts = new Set();

      function captureVisible() {
        document.querySelectorAll('div[role="article"]').forEach(el => {
          const text = (el.innerText || '').trim();
          if (text.length < 40) return;
          const key = text.slice(0, 100);
          if (window.__seenTexts.has(key)) return;
          window.__seenTexts.add(key);

          // Find post URL
          let postUrl = null;
          for (const a of el.querySelectorAll('a[href]')) {
            const h = a.href || '';
            if (!h || h === '#' || h.startsWith('javascript')) continue;
            if (h.includes('/posts/') || h.includes('story_fbid') ||
                h.includes('/permalink/') || h.includes('story.php') ||
                h.includes('/photo/') || h.includes('/video/') ||
                h.includes('/reel/') || h.includes('/watch/')) {
              postUrl = h;
              break;
            }
          }

          // Timestamp
          let postTs = null;
          const t = el.querySelector('time[datetime]');
          if (t) postTs = new Date(t.getAttribute('datetime')).getTime();
          if (postTs !== null && postTs < cutoffMs) return;

          window.__capturedPosts.push({ text: text.slice(0, 800), postUrl, postTs });
        });
      }

      // Capture whatever is in the DOM right now
      captureVisible();

      // Watch for new articles entering the DOM as we scroll
      window.__postObserver = new MutationObserver(captureVisible);
      window.__postObserver.observe(document.body, { childList: true, subtree: true });
    }, cutoff);

    // Scroll through the feed — observer captures posts as they appear
    await humanInteract(page);
    await page.waitForTimeout(2000 + Math.random() * 1500);

    // Save screenshot for debugging
    try {
      await page.screenshot({ path: path.join(__dirname, '../data/page-debug.png'), fullPage: false });
    } catch {}

    // Stop observer and collect all captured posts
    const rawPosts = await page.evaluate(() => {
      if (window.__postObserver) window.__postObserver.disconnect();
      return window.__capturedPosts || [];
    });

    console.log(`[checkFeed] captured ${rawPosts.length} posts via observer`);

    const withUrl = rawPosts.length;
    let keywordHits = 0;

    for (const post of rawPosts) {
      const fingerprint = getPostFingerprint(post.postUrl, post.text);

      if (seedMode) {
        results.push({ fingerprint, seed: true });
        continue;
      }

      const lower = post.text.toLowerCase();
      const matched = keywords.filter(k => lower.includes(k.keyword.toLowerCase()));
      if (matched.length === 0) continue;

      keywordHits++;
      results.push({
        fingerprint,
        postUrl: post.postUrl,
        postText: post.text,
        matchedKeywords: matched,
        postTs: post.postTs,
      });
    }

    return { posts: results, stats: { articles: rawPosts.length, withUrl, keywordHits } };
  } finally {
    await page.close();
  }
}

module.exports = { initBrowser, closeBrowser, checkGroup, checkFeed, takeDebugScreenshot };
