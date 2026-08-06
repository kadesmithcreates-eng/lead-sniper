require('dotenv').config();
const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-now';
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Auth ──────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    const token = jwt.sign({ ok: true }, JWT_SECRET, { expiresIn: '14d' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// ── Status ────────────────────────────────────────────
app.get('/api/status', auth, (req, res) => {
  res.json(db.getStatus());
});

// ── Keywords ──────────────────────────────────────────
app.get('/api/keywords', auth, (req, res) => {
  res.json(db.getKeywords());
});

app.post('/api/keywords', auth, (req, res) => {
  const { keyword } = req.body;
  if (!keyword || !keyword.trim()) return res.status(400).json({ error: 'Keyword is required' });
  res.json(db.addKeyword(keyword));
});

app.delete('/api/keywords/:id', auth, (req, res) => {
  db.removeKeyword(req.params.id);
  res.json({ success: true });
});

// ── Groups ────────────────────────────────────────────
app.get('/api/groups', auth, (req, res) => {
  res.json(db.getGroups());
});

app.post('/api/groups', auth, (req, res) => {
  const { url, name } = req.body;
  if (!url || !url.trim()) return res.status(400).json({ error: 'Group URL is required' });
  res.json(db.addGroup(url, name || ''));
});

app.delete('/api/groups/:id', auth, (req, res) => {
  db.removeGroup(req.params.id);
  res.json({ success: true });
});

app.put('/api/groups/:id/priority', auth, (req, res) => {
  const { priority } = req.body;
  db.setGroupPriority(req.params.id, priority);
  res.json({ success: true });
});

// ── Cookies ───────────────────────────────────────────
app.post('/api/cookies', auth, (req, res) => {
  const { cookies } = req.body;
  if (!cookies || !Array.isArray(cookies)) return res.status(400).json({ error: 'Invalid cookies — must be a JSON array' });
  const cookiesPath = path.join(__dirname, '../data/cookies.json');
  fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
  db.addLog('info', `Cookies updated — ${cookies.length} cookies saved`);
  res.json({ success: true, count: cookies.length });
});

app.get('/api/cookies/status', auth, (req, res) => {
  const cookiesPath = path.join(__dirname, '../data/cookies.json');
  if (!fs.existsSync(cookiesPath)) return res.json({ exists: false });
  const stat = fs.statSync(cookiesPath);
  const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
  res.json({ exists: true, count: cookies.length, updatedAt: stat.mtime });
});

// ── Group auto-import (scrapes Facebook) ─────────────
let scrapeInProgress = false;

app.post('/api/groups/scrape', auth, (req, res) => {
  if (scrapeInProgress) {
    return res.status(409).json({ error: 'Scrape already running — wait for it to finish' });
  }

  scrapeInProgress = true;
  res.json({ started: true, message: 'Scraping your Facebook groups — this takes 2-3 minutes. Refresh the groups list when done.' });

  // Stop monitor first to free memory for Chromium scrape
  exec('pm2 stop fb-monitor', () => {
    setTimeout(() => {
      const child = spawn(process.execPath, [path.join(__dirname, 'scrape-groups.js')], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      let output = '';
      child.stdout.on('data', d => { output += d.toString(); });
      child.stderr.on('data', d => console.error('[scrape]', d.toString()));

      child.on('close', () => {
        scrapeInProgress = false;
        exec('pm2 start fb-monitor');
        try {
          const jsonLine = output.split('\n').find(l => l.startsWith('{'));
          if (jsonLine) {
            const result = JSON.parse(jsonLine);
            db.addLog('info', `Group import: found ${result.found}, added ${result.added}, skipped ${result.skipped} duplicates`);
          }
        } catch {}
      });

      child.on('error', e => {
        scrapeInProgress = false;
        exec('pm2 start fb-monitor');
        db.addLog('error', `Group scrape failed: ${e.message}`);
      });
    }, 2000);
  });
});

app.get('/api/groups/scrape/status', auth, (req, res) => {
  res.json({ inProgress: scrapeInProgress });
});

// ── Group name bulk-fetch ─────────────────────────────
let nameFetchInProgress = false;

app.post('/api/groups/fetch-names', auth, (req, res) => {
  if (nameFetchInProgress) return res.status(409).json({ error: 'Already running — check logs for progress' });
  nameFetchInProgress = true;
  res.json({ started: true, message: 'Fetching group names — takes 15-20 min. Watch logs.' });

  exec('pm2 stop fb-monitor', () => {
    setTimeout(() => {
      const child = spawn(process.execPath, [path.join(__dirname, 'fetch-names.js')], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      child.stderr.on('data', d => console.error('[fetch-names]', d.toString()));

      child.on('close', () => {
        nameFetchInProgress = false;
        exec('pm2 start fb-monitor');
      });

      child.on('error', e => {
        nameFetchInProgress = false;
        exec('pm2 start fb-monitor');
        db.addLog('error', `Name fetch failed: ${e.message}`);
      });
    }, 1500);
  });
});

app.get('/api/groups/fetch-names/status', auth, (req, res) => {
  res.json({ inProgress: nameFetchInProgress });
});

// ── Matches ───────────────────────────────────────────
app.get('/api/matches', auth, (req, res) => {
  res.json(db.getRecentMatches(50));
});

// ── Logs ──────────────────────────────────────────────
app.get('/api/logs', auth, (req, res) => {
  res.json(db.getLogs(150));
});

// ── Fallback to index.html ────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running on port ${PORT}`);
});
