require('dotenv').config();
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

chromium.use(StealthPlugin());

let browser = null;
let context = null;

function buildProxyConfig() {
  if (!process.env.IPROYAL_USERNAME) return {};
  return {
    proxy: {
      server: `http://${process.env.IPROYAL_PROXY_HOST || 'geo.iproyal.com'}:${process.env.IPROYAL_PROXY_PORT || '12321'}`,
      username: process.env.IPROYAL_USERNAME,
      password: process.env.IPROYAL_PASSWORD
    }
  };
}

async function initBrowser() {
  if (browser) await closeBrowser();

  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-default-browser-check',
      '--safebrowsing-disable-auto-update',
      '--js-flags=--max-old-space-size=512',
    ],
    ...buildProxyConfig()
  });

  // Mobile UA — required for mbasic.facebook.com to render properly
  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: [],
  });

  // Load Facebook session cookies
  const cookiesPath = path.join(__dirname, '../data/cookies.json');
  if (fs.existsSync(cookiesPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
      // Support both Cookie-Editor format (array of objects with name/value/domain)
      // and raw Playwright cookie format
      const cookies = raw.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.facebook.com',
        path: c.path || '/',
        httpOnly: c.httpOnly || false,
        secure: c.secure || true,
        sameSite: ({no_restriction:'None',lax:'Lax',strict:'Strict'})[c.sameSite] || 'None',
      }));
      await context.addCookies(cookies);
    } catch (e) {
      console.error('Failed to load cookies:', e.message);
    }
  } else {
    console.warn('No cookies.json found. Place your exported Facebook cookies at data/cookies.json');
  }

  return context;
}

async function closeBrowser() {
  try {
    if (browser) await browser.close();
  } catch {}
  browser = null;
  context = null;
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

    // Human-like pause after page load
    await page.waitForTimeout(2000 + Math.random() * 3000);

    // Human-like scroll pattern — scroll down in chunks with pauses, occasionally back up
    const scrollSteps = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < scrollSteps; i++) {
      const scrollAmount = 400 + Math.floor(Math.random() * 500);
      await page.evaluate(amt => window.scrollBy(0, amt), scrollAmount);
      await page.waitForTimeout(800 + Math.random() * 1200);
      // Occasionally scroll back up slightly like a human re-reading
      if (Math.random() < 0.3) {
        await page.evaluate(() => window.scrollBy(0, -(80 + Math.random() * 120)));
        await page.waitForTimeout(400 + Math.random() * 600);
      }
    }
    await page.waitForTimeout(500 + Math.random() * 1000);

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
    browser = null;
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
