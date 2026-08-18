require('dotenv').config();
const db = require('./db');
const { initBrowser, closeBrowser, checkFeed, takeDebugScreenshot } = require('./facebook');
const { filterAndSummarize } = require('./gemini');
const { sendDiscord, sendTelegram, sendAlert, sendSessionExpiredAlert } = require('./notify');

const SWEEP_INTERVAL_MS = [120000, 180000]; // 2–3 min between sweeps while active

// Randomized cycle durations — no two sessions look identical to Facebook's timing detection.
// Occasionally throw in a longer sleep (1-in-6 chance of 40-60min) like a human who stepped away.
function getActiveDuration() { return (12 + Math.random() * 6) * 60 * 1000; }  // 12–18 min
function getSleepDuration() {
  if (Math.random() < 0.17) return (40 + Math.random() * 20) * 60 * 1000;     // 40–60 min (long break)
  return (13 + Math.random() * 7) * 60 * 1000;                                 // 13–20 min (normal)
}
const ZERO_ALERT_THRESHOLD = 20;            // alert after N empty sweeps in a row

const SEED_MODE = process.argv.includes('--seed');

let sweepCount = 0;
let consecutiveZero = 0;

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

  let feedResult;
  try {
    feedResult = await checkFeed(keywords, seedMode);
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

  const { posts, stats } = feedResult;
  db.updateStatus({ session_alive: 1, last_heartbeat: new Date().toISOString() });
  db.addLog('info', `Scan: ${stats.articles} articles, ${stats.withUrl} with URL, ${stats.keywordHits} keyword hits`);

  if (seedMode) {
    for (const p of posts) db.markPostSeen(p.fingerprint);
    db.addLog('info', `Seed: marked ${posts.length} feed posts as seen`);
    return 0;
  }

  let matchCount = 0;

  for (const post of posts) {
    if (db.isPostSeen(post.fingerprint)) {
      db.addLog('info', `Skipped already-seen post: ${(post.postUrl || '').slice(0, 60)}`);
      continue;
    }
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

// Run one active sweep period — browser stays open across cycles
async function runActivePeriod(firstRun = false) {
  db.addLog('info', '▶️  Active period started');

  if (firstRun) {
    try {
      await initBrowser();
    } catch (e) {
      db.addLog('error', `Browser init failed: ${e.message}`);
      await sendAlert(`❌ Monitor failed to start browser: ${e.message}`);
      return;
    }
  }

  db.updateStatus({ session_alive: 1, last_heartbeat: new Date().toISOString() });

  const activeDuration = getActiveDuration();
  const activeUntil = Date.now() + activeDuration;
  db.addLog('info', `Active window: ${Math.round(activeDuration / 60000)} min`);

  while (Date.now() < activeUntil) {
    try {
      const matches = await runSweep(false);

      if (matches > 0) {
        consecutiveZero = 0;
        db.updateStatus({ last_post_found: new Date().toISOString(), consecutive_zero_sweeps: 0, current_sweep_posts: matches });
      } else {
        consecutiveZero++;
        db.updateStatus({ consecutive_zero_sweeps: consecutiveZero, current_sweep_posts: 0 });
      }

      db.addLog('info', `[Sweep #${sweepCount}] ${matches} match${matches !== 1 ? 'es' : ''} — ${consecutiveZero} empty in a row`);

      if (consecutiveZero >= ZERO_ALERT_THRESHOLD) {
        await sendAlert(`⚠️ 0 articles found in last ${consecutiveZero} sweeps. Possible cookie/session issue.\nCheck: C:\\lead-sniper\\data\\page-debug.html`);
        consecutiveZero = 0;
      }
    } catch (e) {
      if (e.message === 'SESSION_EXPIRED') {
        db.addLog('error', 'Session expired — stopping active period, need new cookies');
        db.updateStatus({ session_alive: 0 });
        await sendSessionExpiredAlert(process.env.DASHBOARD_URL || 'http://localhost:3000');
        break;
      }
      db.addLog('error', `Sweep error: ${e.message}`);
      try {
        await closeBrowser();
        await sleep(3000);
        await initBrowser();
        db.addLog('info', 'Browser restarted after crash');
      } catch (restartErr) {
        db.addLog('error', `Restart failed: ${restartErr.message}`);
        break;
      }
    }

    db.pruneSeenPosts();

    const remaining = activeUntil - Date.now();
    if (remaining < 5000) break; // active period ending

    const delay = Math.min(rand(...SWEEP_INTERVAL_MS), remaining - 2000);
    db.addLog('info', `Next sweep in ${Math.round(delay / 1000)}s (${Math.round(remaining / 60000)}m left in session)`);
    await sleep(delay);
  }

  db.addLog('info', `⏸️  Active period done — browser stays open, sleeping`);
}

async function main() {
  db.addLog('info', '🚀 Feed monitor starting (15-min on / 15-min off cycle)');

  if (SEED_MODE) {
    db.addLog('info', '🌱 Seed mode: marking current feed posts as seen...');
    try {
      await initBrowser();
      await runSweep(true);
      db.updateStatus({ seeded: 1 });
      db.addLog('info', '✅ Seed done. Restart without --seed to begin monitoring.');
    } finally {
      await closeBrowser();
    }
    process.exit(0);
  }

  let cycleNum = 0;
  while (true) {
    cycleNum++;
    db.addLog('info', `=== Cycle #${cycleNum} ===`);
    await runActivePeriod(cycleNum === 1);
    const sleepMs = getSleepDuration();
    db.addLog('info', `😴 Sleeping ${Math.round(sleepMs / 60000)} min before next cycle...`);
    await sleep(sleepMs);
  }
}

main().catch(async (e) => {
  console.error('Fatal:', e);
  await sendAlert(`❌ Fatal crash: ${e.message}`);
  process.exit(1);
});
