require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'monitor.db'));

db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT UNIQUE NOT NULL COLLATE NOCASE,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS groups_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    last_checked TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER,
    group_name TEXT,
    post_url TEXT,
    post_text TEXT,
    matched_keywords TEXT,
    summary TEXT,
    notified_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS seen_posts (
    fingerprint TEXT PRIMARY KEY,
    seen_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS status (
    id INTEGER PRIMARY KEY DEFAULT 1,
    session_alive INTEGER DEFAULT 0,
    last_heartbeat TEXT,
    last_post_found TEXT,
    consecutive_zero_sweeps INTEGER DEFAULT 0,
    current_sweep_posts INTEGER DEFAULT 0,
    total_matches INTEGER DEFAULT 0,
    seeded INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT DEFAULT 'info',
    message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO status (id) VALUES (1);
`);

// Migration: add priority column to existing databases
try { db.exec('ALTER TABLE groups_list ADD COLUMN priority INTEGER DEFAULT 0'); } catch {}

// ── Keywords ──────────────────────────────────────────
function getKeywords() {
  return db.prepare('SELECT * FROM keywords WHERE active = 1 ORDER BY keyword ASC').all();
}

function addKeyword(keyword) {
  try {
    db.prepare('INSERT INTO keywords (keyword) VALUES (?)').run(keyword.trim());
    return { success: true };
  } catch {
    return { success: false, error: 'Keyword already exists' };
  }
}

function removeKeyword(id) {
  db.prepare('UPDATE keywords SET active = 0 WHERE id = ?').run(id);
}

// ── Groups ────────────────────────────────────────────
function getGroups() {
  return db.prepare('SELECT * FROM groups_list WHERE active = 1 ORDER BY priority DESC, created_at DESC').all();
}

function addGroup(url, name = '') {
  try {
    db.prepare('INSERT INTO groups_list (url, name) VALUES (?, ?)').run(url.trim(), name.trim());
    return { success: true };
  } catch {
    return { success: false, error: 'Group already exists' };
  }
}

function removeGroup(id) {
  db.prepare('UPDATE groups_list SET active = 0 WHERE id = ?').run(id);
}

function setGroupPriority(id, priority) {
  db.prepare('UPDATE groups_list SET priority = ? WHERE id = ?').run(priority ? 1 : 0, id);
}

function updateGroupChecked(id, name) {
  db.prepare(`
    UPDATE groups_list
    SET last_checked = datetime('now'), name = CASE WHEN ? != '' THEN ? ELSE name END
    WHERE id = ?
  `).run(name, name, id);
}

// ── Seen posts ────────────────────────────────────────
function isPostSeen(fingerprint) {
  return !!db.prepare('SELECT 1 FROM seen_posts WHERE fingerprint = ?').get(fingerprint);
}

function markPostSeen(fingerprint) {
  db.prepare('INSERT OR IGNORE INTO seen_posts (fingerprint) VALUES (?)').run(fingerprint);
}

function pruneSeenPosts() {
  db.prepare("DELETE FROM seen_posts WHERE seen_at < datetime('now', '-30 days')").run();
}

// ── Matches ───────────────────────────────────────────
function addMatch(groupId, groupName, postUrl, postText, matchedKeywords, summary) {
  db.prepare(`
    INSERT INTO matches (group_id, group_name, post_url, post_text, matched_keywords, summary)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(groupId, groupName, postUrl, postText.slice(0, 500), matchedKeywords.join(', '), summary);
  db.prepare('UPDATE status SET total_matches = total_matches + 1 WHERE id = 1').run();
}

function getRecentMatches(limit = 50) {
  return db.prepare('SELECT * FROM matches ORDER BY notified_at DESC LIMIT ?').all(limit);
}

// ── Status ────────────────────────────────────────────
function getStatus() {
  return db.prepare('SELECT * FROM status WHERE id = 1').get();
}

function updateStatus(fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE status SET ${sets} WHERE id = 1`).run(...Object.values(fields));
}

// ── Logs ──────────────────────────────────────────────
function addLog(level, message) {
  console.log(`[${level.toUpperCase()}] ${message}`);
  db.prepare('INSERT INTO logs (level, message) VALUES (?, ?)').run(level, message);
  db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 500)').run();
}

function getLogs(limit = 100) {
  return db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  getKeywords, addKeyword, removeKeyword,
  getGroups, addGroup, removeGroup, updateGroupChecked, setGroupPriority,
  isPostSeen, markPostSeen, pruneSeenPosts,
  addMatch, getRecentMatches,
  getStatus, updateStatus,
  addLog, getLogs
};
