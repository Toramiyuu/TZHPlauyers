/*
 * dev-server.js — zero-dependency local preview.
 *
 * server.js depends on express, which crashes under Node 26 in this environment
 * (finalhandler/debug incompatibility). This standalone server needs NO npm deps:
 * it stubs @upstash/redis with an in-memory store, mounts the REAL api/state.js
 * handler at /api/state, and serves public/ statically. Throwaway dev tool —
 * production still uses api/state.js on Vercel. Run: node dev-server.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── In-memory Upstash stub, injected before api/state.js is required ─────────
let STORE = null;
require.cache[require.resolve('@upstash/redis')] = {
  id: require.resolve('@upstash/redis'), loaded: true, exports: {
    Redis: class { async get() { return STORE; } async set(_k, v) { STORE = v; return 'OK'; } },
  },
};
process.env.KV_REST_API_URL = 'http://local-stub';
process.env.KV_REST_API_TOKEN = 'local-stub';
const apiHandler = require('./api/state.js');

// ── Seed demo state (incl. weekly regulars) so the feature is visible ────────
function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const today = new Date();
const todayIso = iso(today);
const wd = today.getDay();                 // 0=Sun..6=Sat
const other = (wd + 2) % 7, other2 = (wd + 4) % 7;
STORE = {
  roster: ['Harvey','Desmond','Celine','Sharmin','Terence','Alex','Kokyan','Yit Fung',
    'Ong Yi','Shane','Boon Chuan','Guo Ping','Kenn','Wei Hao','Yau','Jimmy','Jian','dean',
    'Choon','Daryl','Karine','Seng','Zheng Quan','Chee Han','Milo','Ah Sheng','Michelle',
    'Terrence','Yao','Daniel','Henry','Joe','Danny','Hui Tian','Ah Xiang','Irene','Yugene',
    'Kuan Ming','Yong Jun','Vunhao','Mi Sung','Wei Chong','Hao','Justin','Boey','Harvey Ng',
  ].map((name, i) => ({ id: 'p' + i, name, photo: null, points: (i * 7) % 15 })),
  players: [{ id: 'p5', name: 'Alex' }],   // Alex already ticked in for today
  numCourts: 2,
  courtNumbers: [1, 2],
  rounds: [],
  currentRound: 0,
  courtRounds: [0, 0],
  endingSoon: [],
  sessionDate: todayIso,
  sessions: {},
  // Weekly regulars: today's weekday has 3 (Harvey among them) so the Session
  // tab shows the "Add regulars" prompt on load; two other days are populated
  // so the editor's day badges look realistic.
  regulars: {
    [String(wd)]: ['p0', 'p3', 'p6'],
    [String(other)]: ['p0', 'p1'],
    [String(other2)]: ['p2', 'p5', 'p7'],
  },
  luckyDraw: { entries: [], paid: [], drawDate: todayIso, spin: null, results: [], history: [] },
  monthlyDraw: { month: '', rollSuppressedMonth: '', prizes: [], participants: [], results: [], spin: null, history: [] },
  socialGames: [
    { id: 'sg-fri', day: 'Friday', weekday: 5, time: '9–11pm', enabled: true },
    { id: 'sg-sun', day: 'Sunday', weekday: 0, time: '9–11pm', enabled: true },
    { id: 'sg-mon', day: 'Monday', weekday: 1, time: '9–11pm', enabled: true },
  ],
  signups: [],
  accounts: [],
};

// ── Adapt Node's req/res to the Vercel-style handler contract ────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const PUBLIC = path.join(__dirname, 'public');

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state') {
    const query = Object.fromEntries(url.searchParams.entries());
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch (e) { body = {}; } }
      // Shim res into the { setHeader, status().json(), json(), end() } shape.
      const shim = {
        setHeader: (k, v) => res.setHeader(k, v),
        status(code) { res.statusCode = code; return this; },
        json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return this; },
        end() { res.end(); return this; },
      };
      apiHandler({ method: req.method, query, body }, shim);
    });
    return;
  }
  serveStatic(req, res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  TZH dev preview running (in-memory, Node-26 safe)\n`);
  console.log(`  Viewer:  http://localhost:${PORT}/`);
  console.log(`  Admin:   http://localhost:${PORT}/?admin   (password: TZH123)\n`);
  console.log(`  Seeded: session date ${todayIso}; today's regulars = Harvey, Sharmin, Kokyan (Alex already in).\n`);
});
