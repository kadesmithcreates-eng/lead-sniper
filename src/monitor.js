require('dotenv').config();
const db = require('./db');
const { initBrowser, closeBrowser, checkGroup, takeDebugScreenshot } = require('./facebook');
const { filterAndSummarize } = require('./gemini');
const { sendDiscord, sendTelegram, sendAlert, sendSessionExpiredAlert } = require('./notify');

const NORMAL_BATCH_SIZE = 25;          // normal groups checked per sweep
const MIN_DELAY_MS = 3 * 60 * 1000;   // 3 min minimum between sweeps
const MAX_DELAY_MS = 6 * 60 * 1000;   // 6 min maximum
const GROUP_DELAY_MS = [6000, 14000];  // pause between individual groups
const ZERO_ALERT_THRESHOLD = 50;       // empty sweeps before alerting (~8+ hrs)
const BROWSER_RESTART_INTERVAL = 75;  // restart browser every N groups

const SEED_MODE = process.argv.includes('--seed');

let currentBatchIndex = 0;
let groupsCheckedSinceRestart = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return min + Math.random() * (max - min); }

async function processGroup(group, keywords, seedMode) {
  let checkResult;
  try {
    checkResult = await checkGroup(group, keywords, seedMode);
  } catch (e) {
    db.addLog('error', `Failed to check group "${group.name || group.url}": ${e.message}`);
    return 0;
  }

  const { results, groupName } = checkResult;
  db.updateGroupChecked(group.id, groupName);

  if (seedMode) {
    for (const r of results) db.markPostSeen(r.fingerprint);
    return 0;
  }

  let matchCount = 0;

  for (const post of results) {
    if (db.isPostSeen(post.fingerprint)) continue;
    db.markPostSeen(post.fingerprint);

    // AI filter
    const { relevant, summary } = await filterAndSummarize(post.postText, post.matchedKeywords, post.postTs);
    if (!relevant) {
      db.addLog('info', `Gemini filtered: not relevant in ${groupName}`);
      continue;
    }

    // Save to DB
    db.addMatch(group.id, groupName, post.postUrl, post.postText, post.matchedKeywords, summary);
    matchCount++;

    // Notify on both channels simultaneously
    await Promise.allSettled([
      sendDiscord(groupName, post.postUrl, summary, post.matchedKeywords),
      sendTelegram(groupName, post.postUrl, summary, post.matchedKeywords)
    ]);

    db.addLog('info', `✅ Match in "${groupName}" — ${post.matchedKeywords.map(k => k.keyword).join(', ')}`);
  }

  return matchCount;
}

async function runSweep(seedMode = false) {
  const allGroups = db.getGroups();
  const keywords = db.getKeywords();

  if (allGroups.length === 0) {
    db.addLog('warn', 'No groups configured — add groups in the dashboard');
    db.updateStatus({ session_alive: 1, last_heartbeat: new Date().toISOString() });
    return;
  }

  if (!seedMode && keywords.length === 0) {
    db.addLog('warn', 'No keywords configured — add keywords in the dashboard');
    db.updateStatus({ session_alive: 1, last_heartbeat: new Date().toISOString() });
    return;
  }

  // Split by tier: Tier 1 (starred) checked every sweep, Tier 2 rotates in batches
  const tier1 = allGroups.filter(g => g.priority === 1);
  const tier2 = allGroups.filter(g => g.priority !== 1);

  let normalBatch = [];
  if (tier2.length > 0) {
    const start = currentBatchIndex % tier2.length;
    normalBatch = tier2.slice(start, Math.min(start + NORMAL_BATCH_SIZE, tier2.length));
    currentBatchIndex = (start + NORMAL_BATCH_SIZE) % tier2.length;
  }

  // Tier 1 always runs first every sweep
  const batch = [...tier1, ...normalBatch];

  const label = seedMode ? 'SEED' : 'SWEEP';
  if (tier1.length > 0) {
    db.addLog('info', `[${label}] ${tier1.length} tier-1 ★ + ${normalBatch.length} normal groups (${tier2.length} total normal)`);
  } else {
    const start = normalBatch.length > 0 ? (currentBatchIndex - normalBatch.length + tier2.length) % tier2.length : 0;
    db.addLog('info', `[${label}] Checking ${batch.length} groups (${start + 1}–${start + normalBatch.length} of ${allGroups.length})`);
  }

  let sweepMatches = 0;
  let sessionOk = true;

  for (const group of batch) {
    // Periodically restart the browser to prevent memory/session drift
    groupsCheckedSinceRestart++;
    if (groupsCheckedSinceRestart >= BROWSER_RESTART_INTERVAL) {
      db.addLog('info', 'Scheduled browser restart for memory hygiene');
      await closeBrowser();
      await initBrowser();
      groupsCheckedSinceRestart = 0;
    }

    try {
      const count = await processGroup(group, keywords, seedMode);
      sweepMatches += count;
    } catch (e) {
      if (e.message === 'SESSION_EXPIRED') {
        db.addLog('error', 'Facebook session expired — sending Telegram alert with refresh button');
        db.updateStatus({ session_alive: 0 });
        const dashUrl = process.env.DASHBOARD_URL || 'http://your-server:3000';
        await sendSessionExpiredAlert(dashUrl);
        return;
      }
      db.addLog('error', `Group error: ${e.message}`);
      if (e.message.includes('net::ERR') || e.message.includes('timeout')) sessionOk = false;
    }

    // Random human-like delay between groups
    await sleep(rand(...GROUP_DELAY_MS));
  }

  // Update status
  const prevStatus = db.getStatus();
  const zeroCount = sweepMatches === 0
    ? (prevStatus.consecutive_zero_sweeps || 0) + 1
    : 0;

  db.updateStatus({
    session_alive: sessionOk ? 1 : 0,
    last_heartbeat: new Date().toISOString(),
    ...(sweepMatches > 0 ? { last_post_found: new Date().toISOString() } : {}),
    consecutive_zero_sweeps: zeroCount,
    current_sweep_posts: sweepMatches
  });

  // Dead man's switch — alert once after N consecutive empty sweeps, then reset
  if (!seedMode && zeroCount >= ZERO_ALERT_THRESHOLD) {
    const msg = `⚠️ FB Monitor may be broken — 0 new matches in last ${zeroCount} sweeps.\n\nThis usually means:\n• Facebook changed their HTML (selectors broke)\n• Session cookies expired\n• IP blocked\n\nDashboard: ${process.env.DASHBOARD_URL || 'check your VPS'}`;
    await sendAlert(msg);

    const screenshot = await takeDebugScreenshot();
    if (screenshot) db.addLog('warn', `Debug screenshot saved: ${screenshot}`);

    await closeBrowser();
    await initBrowser();
    groupsCheckedSinceRestart = 0;
    db.addLog('warn', `Dead man's switch triggered (${zeroCount} empty sweeps) — browser restarted`);

    // Reset counter so it doesn't fire every sweep after this
    db.updateStatus({ consecutive_zero_sweeps: 0 });
  }

  if (!seedMode) {
    db.addLog('info', `Sweep done. ${sweepMatches} new match${sweepMatches !== 1 ? 'es' : ''} found.`);
  }

  db.pruneSeenPosts();
}

async function seedRun() {
  db.addLog('info', '🌱 Seed mode: marking existing posts as seen (no notifications)...');
  const groups = db.getGroups();

  for (let i = 0; i < groups.length; i += NORMAL_BATCH_SIZE) {
    const batch = groups.slice(i, i + NORMAL_BATCH_SIZE);
    db.addLog('info', `[SEED] ${i + 1}–${Math.min(i + NORMAL_BATCH_SIZE, groups.length)} of ${groups.length}`);
    for (const group of batch) {
      groupsCheckedSinceRestart++;
      if (groupsCheckedSinceRestart >= BROWSER_RESTART_INTERVAL) {
        await closeBrowser();
        await initBrowser();
        groupsCheckedSinceRestart = 0;
      }
      try { await processGroup(group, [], true); } catch (e) {
        db.addLog('error', `Seed error: ${e.message}`);
      }
      await sleep(rand(...GROUP_DELAY_MS));
    }
  }

  db.updateStatus({ seeded: 1 });
  db.addLog('info', '✅ Seed complete. Restart without --seed to begin monitoring.');
}

async function main() {
  db.addLog('info', '🚀 Facebook Monitor starting...');

  try {
    await initBrowser();
    db.addLog('info', 'Browser initialized');
  } catch (e) {
    db.addLog('error', `Browser init failed: ${e.message}`);
    await sendAlert(`❌ Monitor failed to start — browser error: ${e.message}`);
    process.exit(1);
  }

  if (SEED_MODE) {
    await seedRun();
    await closeBrowser();
    process.exit(0);
  }

  db.updateStatus({ session_alive: 1, last_heartbeat: new Date().toISOString() });

  // Main loop
  while (true) {
    try {
      await runSweep(false);
    } catch (e) {
      db.addLog('error', `Sweep error: ${e.message}`);
      await sendAlert(`❌ Monitor sweep error: ${e.message}`);

      // Try to recover
      try {
        await closeBrowser();
        await initBrowser();
      } catch {}
    }

    const delay = rand(MIN_DELAY_MS, MAX_DELAY_MS);
    db.addLog('info', `Next sweep in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
}

main().catch(async (e) => {
  console.error('Fatal:', e);
  await sendAlert(`❌ Fatal monitor crash: ${e.message}`);
  process.exit(1);
});
