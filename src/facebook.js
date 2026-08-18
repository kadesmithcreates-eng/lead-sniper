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

// Rotate between a few realistic mobile UAs so the fingerprint isn't identical every session
const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; moto g(60)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
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

  // Slightly randomize viewport each session — no two sessions look identical
  const width  = 375 + Math.floor(Math.random() * 40);
  const height = 812 + Math.floor(Math.random() * 80);
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  // launchPersistentContext saves the full browser profile to disk:
  // cookies, localStorage, cache, history — so every session looks like
  // a returning user, not a fresh browser install.
  // headless: false removes 40+ detectable headless signals.
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
      '--start-minimized',
    ],
    userAgent: ua,
    viewport: { width, height },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    ...buildProxyConfig(),
  });

  // Only inject cookies.json on the very first run (no saved profile yet).
  // After first run the profile handles its own session persistence.
  const profileExists = fs.existsSync(path.join(USER_DATA_DIR, 'Default', 'Preferences'));
  if (!profileExists) {
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
    await page.goto('https://mbasic.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    const url = page.url();
    if (url.includes('/login') || url.includes('login.php')) throw new Error('SESSION_EXPIRED');

    // Save snapshot every time for debugging
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(__dirname, '../data/page-debug.html'), html);
    } catch {}

    await page.waitForTimeout(1500 + Math.random() * 1000);

    // Click "More" to load extra posts if available
    try {
      const moreLink = await page.$('a[href*="timelineSectionLoadingID"], a[href*="more_stories"], a[href*="LastCursor"], a[href*="cursor"]');
      if (moreLink) {
        await moreLink.click();
        await page.waitForTimeout(2000 + Math.random() * 1000);
      }
    } catch {}

    const cutoff = Date.now() - 8 * 60 * 60 * 1000;

    const rawPosts = await page.evaluate((cutoffMs) => {
      const SKIP = ['/login', '/messages/', '/marketplace/', '/events/', 'javascript:', '/notifications/', 'l.facebook.com'];
      const seen = new Set();
      const posts = [];

      // mbasic story links — Like/Comment buttons all link to story.php
      // Also catch /permalink/ (group posts) and /posts/ (profile posts)
      function isStoryHref(h) {
        if (!h || SKIP.some(s => h.includes(s))) return false;
        return h.includes('story.php') || h.includes('story_fbid') ||
               h.includes('/permalink/') || h.includes('/posts/');
      }

      // Walk UP from a link to find a natural story container.
      // mbasic wraps each story in a <div> that contains author + text + timestamp + actions.
      // We climb until we find a div whose text is between 40 and 3000 chars.
      function getStoryContainer(el) {
        let node = el;
        let best = el.parentElement;
        for (let i = 0; i < 10; i++) {
          if (!node.parentElement || node.parentElement === document.body) break;
          node = node.parentElement;
          const len = (node.innerText || '').trim().length;
          if (len >= 40 && len <= 3000) best = node;
          if (len > 3000) break; // gone too far up — stop
        }
        return best;
      }

      // Collect all story-linked <a> tags
      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter(a => isStoryHref(a.href));

      for (const link of links) {
        const href = link.href;
        const baseUrl = href.split('&')[0]; // strip extra params for dedup
        if (seen.has(baseUrl)) continue;
        seen.add(baseUrl);

        const container = getStoryContainer(link);
        const text = (container?.innerText || '').trim();
        if (text.length < 25) continue;

        // Timestamp: mbasic uses <abbr data-utime="..."> inside the story
        let postTs = null;
        try {
          const abbr = container?.querySelector('abbr[data-utime]');
          if (abbr) postTs = parseInt(abbr.getAttribute('data-utime'), 10) * 1000;
        } catch {}
        if (postTs !== null && postTs < cutoffMs) continue;

        posts.push({ text: text.slice(0, 800), postUrl: href, postTs });
      }

      // Hard fallback: if we still got nothing, return the full page text as one block.
      // At minimum this tells us if keywords are visible at all on the page.
      if (posts.length === 0) {
        const fullText = (document.body.innerText || '').trim();
        if (fullText.length > 100) {
          const anyStoryLink = Array.from(document.querySelectorAll('a[href]'))
            .find(a => isStoryHref(a.href))?.href || 'https://mbasic.facebook.com/';
          posts.push({ text: fullText.slice(0, 1500), postUrl: anyStoryLink, postTs: null, fullPage: true });
        }
      }

      return posts;
    }, cutoff);

    const withUrl = rawPosts.filter(p => p.postUrl).length;
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
