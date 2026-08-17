require('dotenv').config();
const db = require('./db');
const { initBrowser, closeBrowser, checkFeed, takeDebugScreenshot } = require('./facebook');
const { filterAndSummarize } = require('./gemini');
const { sendDiscord, sendTelegram, sendAlert, sendSessionExpiredAlert } = require('./notify');

const FEED_INTERVAL_MS = [120000, 180000]; // 2–3 min between sweeps (sweep itself takes ~1 min)
const ZERO_ALERT_THRESHOLD = 30;           // ~2.5 hrs of empty sweeps before alerting
const BROWSER_RESTART_EVERY = 20;         // restart browser every N sweeps (memory hygiene)

const SEED_MODE = process.argv.includes('--seed');

let sweepCount = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return min + Math.random() * (max - min); }

async function runSweep(seedMode = false) {
  const keywords = db.getKeywords();

  if (!seedMode && keywords.length === 0) {
    db.addLog('warn', 'No keywords set — add keywords in the dashboard');
    db.updateStatus({ session_alive: 1, last_heartbeat: new Date().toISOString() });
    return 0;
  }

  sweepCount++;

  // Periodic browser restart to prevent memory/session drift
  if (sweepCount % BROWSER_RESTART_EVERY === 0) {
    db.addLog('info', 'Scheduled browser restart');
    await closeBrowser();
    await initBrowser();
  }

  let posts;
  try {
    posts = await checkFeed(keywords, seedMode);
  } catch (e) {
    if (e.message === 'SESSION_EXPIRED') {
      db.addLog('error', 'Facebook session expired — need new cookies');
      db.updateStatus({ session_alive: 0 });
      const dashUrl = process.env.DASHBOARD_URL || 'http://your-server:3000';
      await sendSessionExpiredAlert(dashUrl);
      return 0;
    }
    throw e;
  }

  db.updateStatus({ session_alive: 1, last_heartbeat: new Date().toISOString() });

  if (seedMode) {
    for (const p of posts) db.markPostSeen(p.fingerprint);
    db.addLog('info', `Seed: marked ${posts.length} feed posts as seen`);
    return 0;
  }

  let matchCount = 0;

  for (const post of posts) {
    if (db.isPostSeen(post.fingerprint)) continue;
    db.markPostSeen(post.fingerprint);

    const { relevant, summary } = await filterAndSummarize(post.postText, post.matchedKeywords, post.postTs);
    if (!relevant) {
      db.addLog('info', `AI filtered out a post — not relevant`);
      continue;
    }

    db.addMatch(null, 'Facebook Feed', post.postUrl, post.postText, post.matchedKeywords, summary);
    matchCount++;

    await Promise.allSettled([
      sendDiscord('Facebook Feed', post.postUrl, summary, post.matchedKeywords),
      sendTelegram('Facebook Feed', post.postUrl, summary, post.matchedKeywords)
    ]);

    db.addLog('info', `✅ Match in feed — ${post.matchedKeywords.map(k => k.keyword).join(', ')}`);
  }

  return matchCount;
}

async function main() {
  db.addLog('info', '🚀 Feed monitor starting...');

  try {
    await initBrowser();
    db.addLog('info', 'Browser initialized');
  } catch (e) {
    db.addLog('error', `Browser init failed: ${e.message}`);
    await sendAlert(`❌ Monitor failed to start: ${e.message}`);
    process.exit(1);
  }

  if (SEED_MODE) {
    db.addLog('info', '🌱 Seed mode: marking current feed posts as seen...');
    await runSweep(true);
    db.updateStatus({ seeded: 1 });
    db.addLog('info', '✅ Seed done. Restart without --seed to begin monitoring.');
    await closeBrowser();
    process.exit(0);
  }

  db.updateStatus({ session_alive: 1, last_heartbeat: new Date().toISOString() });

  let consecutiveZero = 0;
  let loopCounter = 0;

  while (true) {
    loopCounter++;
    try {
      const matches = await runSweep(false);
      if (matches > 0) {
        consecutiveZero = 0;
        db.updateStatus({ last_post_found: new Date().toISOString(), consecutive_zero_sweeps: 0, current_sweep_posts: matches });
      } else {
        consecutiveZero++;
        db.updateStatus({ consecutive_zero_sweeps: consecutiveZero, current_sweep_posts: 0 });
      }

      db.addLog('info', `[Loop #${loopCounter}] ${matches} match${matches !== 1 ? 'es' : ''} found`);

      // Dead man's switch
      if (consecutiveZero >= ZERO_ALERT_THRESHOLD) {
        const msg = `⚠️ Feed monitor may be broken — 0 matches in last ${consecutiveZero} sweeps (~${Math.round(consecutiveZero * 4)} min).\nPossible causes: session expired, IP blocked, Facebook layout change.\nDashboard: ${process.env.DASHBOARD_URL || 'check your VPS'}`;
        await sendAlert(msg);
        const screenshot = await takeDebugScreenshot();
        if (screenshot) db.addLog('warn', `Debug screenshot: ${screenshot}`);
        await closeBrowser();
        await initBrowser();
        consecutiveZero = 0;
      }
    } catch (e) {
      db.addLog('error', `Sweep error: ${e.message}`);
      await sendAlert(`❌ Monitor sweep error: ${e.message}`);
      try {
        await closeBrowser();
        await new Promise(r => setTimeout(r, 5000)); // let OS reclaim memory before restarting
        await initBrowser();
        db.addLog('info', 'Browser restarted after crash');
      } catch (restartErr) {
        db.addLog('error', `Browser restart failed: ${restartErr.message}`);
      }
    }

    db.pruneSeenPosts();
    const delay = rand(...FEED_INTERVAL_MS);
    db.addLog('info', `Next check in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
}

main().catch(async (e) => {
  console.error('Fatal:', e);
  await sendAlert(`❌ Fatal crash: ${e.message}`);
  process.exit(1);
});
