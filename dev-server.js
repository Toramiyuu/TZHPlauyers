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
const HASHES = new Map(); // key -> Map(field -> string)  (the `court-draws` results hash)
require.cache[require.resolve('@upstash/redis')] = {
  id: require.resolve('@upstash/redis'), loaded: true, exports: {
    Redis: class {
      async get() { return STORE; }
      async set(_k, v) { STORE = v; return 'OK'; }
      async hget(k, f) { const h = HASHES.get(k); return h && h.has(f) ? h.get(f) : null; }
      async hgetall(k) { const h = HASHES.get(k); if (!h || !h.size) return null; return Object.fromEntries(h); }
      async hsetnx(k, f, v) { let h = HASHES.get(k); if (!h) { h = new Map(); HASHES.set(k, h); } if (h.has(f)) return 0; h.set(f, String(v)); return 1; }
    },
  },
};
process.env.KV_REST_API_URL = 'http://local-stub';
process.env.KV_REST_API_TOKEN = 'local-stub';
// Let the demo seed pre-date the real feature epoch so past nights get drawn locally.
process.env.DRAW_EPOCH = '2026-08-01';
const apiHandler = require('./api/state.js');
const drawsHandler = require('./api/draws.js');
const cronDrawHandler = require('./api/cron-session-draw.js');
const SD = require('./public/session-draw.js');
const ML = require('./public/monthly-lucky.js');

// ── Seed demo state (incl. weekly regulars) so the feature is visible ────────
function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const today = new Date();
const todayIso = iso(today);
const wd = today.getDay();                 // 0=Sun..6=Sat
const other = (wd + 2) % 7, other2 = (wd + 4) % 7;
// Test members (LOCAL ONLY — never touches production). Every roster field the
// admin UI reads is populated so each tab has something to show: level 1.0–7.0
// in 0.5 steps, Girl + Mixed flags (drive level-balanced matchmaking), points
// spread across the loyalty tiers, and a phone so Accounts can link to them.
const TEST_NAMES = ['Harvey','Desmond','Celine','Sharmin','Terence','Alex','Kokyan','Yit Fung',
  'Ong Yi','Shane','Boon Chuan','Guo Ping','Kenn','Wei Hao','Yau','Jimmy','Jian','dean',
  'Choon','Daryl','Karine','Seng','Zheng Quan','Chee Han','Milo','Ah Sheng','Michelle',
  'Terrence','Yao','Daniel','Henry','Joe','Danny','Hui Tian','Ah Xiang','Irene','Yugene',
  'Kuan Ming','Yong Jun','Vunhao','Mi Sung','Wei Chong','Hao','Justin','Boey','Harvey Ng'];
const TEST_GIRLS = new Set(['Celine', 'Sharmin', 'Karine', 'Michelle', 'Hui Tian', 'Irene', 'Mi Sung', 'Boey']);
const TEST_ROSTER = TEST_NAMES.map((name, i) => ({
  id: 'p' + i, name, photo: null,
  points: (i * 7) % 41,                       // 0–40 so Bronze→Gold tiers all appear
  level: 1 + ((i * 3) % 13) / 2,              // 1.0 … 7.0 in 0.5 steps
  girl: TEST_GIRLS.has(name),
  mixed: TEST_GIRLS.has(name) || i % 4 === 0, // every girl + every 4th player plays mixed
  phone: '01' + String(23456789 + i * 7919).slice(0, 8),
}));
// Tonight: the first 12 members are ticked in and Round 1 is already built on
// both courts (8 playing, 4 resting) so Courts / Payments / End of the day have
// real rows to work with straight away.
const TEST_PLAYING = TEST_ROSTER.slice(0, 12).map((r) => ({ id: r.id, name: r.name }));
STORE = {
  roster: TEST_ROSTER,
  players: TEST_PLAYING,
  numCourts: 2,
  courtNumbers: [1, 2],
  rounds: [{ label: 'Round 1', courts: [
    { team1: ['p0', 'p1'], team2: ['p2', 'p3'] },
    { team1: ['p4', 'p5'], team2: ['p6', 'p7'] },
  ] }],
  currentRound: 0,
  courtRounds: [0, 0],
  endingSoon: [],
  sessionDate: todayIso,
  sessions: {},
  feeTier: '3h',
  // Weekly regulars: today's weekday has 3 (Harvey among them) so the Session
  // tab shows the "Add regulars" prompt on load; two other days are populated
  // so the editor's day badges look realistic.
  regulars: {
    [String(wd)]: ['p0', 'p3', 'p6'],
    [String(other)]: ['p0', 'p1'],
    [String(other2)]: ['p2', 'p5', 'p7'],
  },
  luckyDraw: { entries: [], paid: [], drawDate: todayIso, spin: null, results: [], history: [] },
  socialGames: [
    { id: 'sg-fri', day: 'Friday', weekday: 5, time: '9–11pm', enabled: true },
    { id: 'sg-sun', day: 'Sunday', weekday: 0, time: '9–11pm', enabled: true },
    { id: 'sg-mon', day: 'Monday', weekday: 1, time: '9–11pm', enabled: true },
  ],
  signups: [],
  // Two members already hold login codes (LOCAL ONLY): sign in on the viewer with
  // Harvey#123 or Desmond#456 to see the member page. "Assign codes to everyone"
  // on the admin Accounts tab fills in the rest.
  accounts: [
    { id: 'acc_local_harvey', v: 2, phone: '', phoneDisplay: '', status: 'active', pwHash: null, pwSalt: null, pwEnc: null,
      tempPassword: false, forceChange: false, failedAttempts: 0, lockedAt: null, lockedReason: null, suspendedAt: null, suspendedReason: null,
      lastLoginAt: null, pwChangedAt: 0, requestedAt: 0, createdAt: 0, updatedAt: 0, approvedBy: 'seed', approvedAt: 0,
      rejectedBy: null, rejectedAt: null, rejectedReason: null, moreInfoMsg: null, moreInfoAt: null, playerId: 'p0', playerHint: 'Harvey',
      name: 'Harvey', token: null, source: 'code', code: 'Harvey#123', codeKey: 'harvey123', codeUpdatedAt: 0, codeFails: 0, codeFailAt: null, codeLastLoginAt: null },
    { id: 'acc_local_desmond', v: 2, phone: '', phoneDisplay: '', status: 'active', pwHash: null, pwSalt: null, pwEnc: null,
      tempPassword: false, forceChange: false, failedAttempts: 0, lockedAt: null, lockedReason: null, suspendedAt: null, suspendedReason: null,
      lastLoginAt: null, pwChangedAt: 0, requestedAt: 0, createdAt: 0, updatedAt: 0, approvedBy: 'seed', approvedAt: 0,
      rejectedBy: null, rejectedAt: null, rejectedReason: null, moreInfoMsg: null, moreInfoAt: null, playerId: 'p1', playerHint: 'Desmond',
      name: 'Desmond', token: null, source: 'code', code: 'Desmond#456', codeKey: 'desmond456', codeUpdatedAt: 0, codeFails: 0, codeFailAt: null, codeLastLoginAt: null },
  ],
  drawSettings: { winners: 2 },
  sessionDrawAt: SD.scheduledDrawAt(todayIso),
};

// ── Monthly (points) Lucky Draw seed ────────────────────────────────────────
// A handful of members are already past 80 points this month, three prizes are
// set, and LAST month is closed with its own 80+ players so the automatic draw
// fires on the first view of the tab / public page.
(function seedMonthlyLucky() {
  STORE.roster.forEach((r, i) => { if (i % 5 === 0) r.points = 80 + (i * 3) % 40; });
  const thisMonth = ML.monthKeyOf(todayIso);
  const points = {}, names = {};
  STORE.roster.forEach((r, i) => { points[r.id] = i % 4 === 0 ? 80 + i : (i * 7) % 60; names[r.id] = r.name; });
  // Three closed months, so the record list and its year calendar have history.
  const closed = {};
  for (let back = 1; back <= 3; back++) {
    const m = ML.shiftMonthKey(thisMonth, -back);
    closed[m] = { month: m, closedAt: Date.now() - back * 30 * 864e5, points, names };
  }
  STORE.monthlyLucky = {
    auto: true, winners: 3, threshold: 80,
    prizes: [
      { id: 'pz1', name: 'Restring + grip', qty: 1, place: 1, desc: 'Your choice of string, fitted at the shop, with a fresh overgrip on top.', photo: null },
      { id: 'pz2', name: 'Overgrip pack', qty: 1, place: 2, desc: 'Three overgrips in your pick of colour.', photo: null },
      { id: 'pz3', name: 'Tube of shuttlecocks', qty: 1, place: 3, desc: 'Twelve shuttles, collected at your next session.', photo: null },
    ],
    pointsMonth: thisMonth, pool: null, closed,
  };
})();

// ── Seed the last three draw-day nights so the Lucky Draw page has content ──
// Most recent (still pending) and older ones (due -> auto-drawn on first view).
// Each night: ~14 players; most paid the same night (eligible), one paid AFTER
// the draw time (late, not eligible), one unpaid.
(function seedDrawNights() {
  const nights = [];
  for (let back = 1; back <= 21 && nights.length < 3; back++) {
    const d = new Date(today); d.setDate(d.getDate() - back);
    const isoD = iso(d);
    if (SD.isDrawDay(isoD)) nights.push(isoD);
  }
  STORE.attendance = {};
  nights.forEach((date, ni) => {
    const start = (ni * 5) % 30;
    const players = STORE.roster.slice(start, start + 14).map((r) => ({ id: r.id, name: r.name }));
    STORE.sessions[date] = { players, rounds: [], numCourts: 2, courtNumbers: [1, 2], courtRounds: [], feeTier: '3h', drawAt: SD.scheduledDrawAt(date) };
    const drawAt = SD.scheduledDrawAt(date);
    const paidSameNight = SD.mytInstant(date, '22:30');
    const entries = {};
    players.forEach((p, i) => {
      const paid = i !== 0;                                     // player 0 never pays
      const paidAt = !paid ? null : (i === 1 ? drawAt + 2 * 3600 * 1000 : paidSameNight + i * 60000); // player 1 pays late
      entries[p.id] = { playerId: p.id, name: p.name, present: true, paid, source: 'session',
        payment: { fee: 25, tier: '3h', method: paid ? (i % 2 ? 'cash' : 'tng') : null, paidAt, markedBy: paid ? 'admin' : null, feeOverridden: false, createdAt: paidSameNight, updatedAt: paidSameNight } };
    });
    STORE.attendance[date] = { date, weekday: SD.isoWeekday(date), updatedAt: paidSameNight, entries, payments: { tier: '3h', generatedAt: paidSameNight, generatedBy: 'admin' } };
  });
  STORE.__seededDrawNights = nights;
  // One manual quick draw (with the reel pool each winner was drawn from) so the
  // calendar shows a second mark and its replay video can be tried locally.
  const qdDate = nights[0] || todayIso;
  const qdPool = STORE.roster.slice(0, 9).map((r) => r.name);
  STORE.luckyDraw.history = [{ date: qdDate, at: SD.mytInstant(qdDate, '23:05'), winners: [
    { rank: 1, name: qdPool[3], pool: qdPool.slice() },
    { rank: 2, name: qdPool[6], pool: qdPool.filter((n) => n !== qdPool[3]) },
  ] }];
})();

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

function shimRes(res) {
  return {
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) { res.statusCode = code; return this; },
    json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return this; },
    end() { res.end(); return this; },
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/draws') {
    const query = Object.fromEntries(url.searchParams.entries());
    drawsHandler({ method: req.method, query, headers: req.headers, body: {} }, shimRes(res));
    return;
  }
  if (url.pathname === '/api/cron-session-draw') {
    cronDrawHandler({ method: req.method, query: {}, headers: req.headers, body: {} }, shimRes(res));
    return;
  }
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

// TZH_DUMP_SEED=1 prints the seeded state as JSON and exits, so the same fixture
// can be loaded into a throwaway Redis key for a sandbox deployment.
if (process.env.TZH_DUMP_SEED) { process.stdout.write(JSON.stringify(STORE)); process.exit(0); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  TZH dev preview running (in-memory, Node-26 safe)\n`);
  console.log(`  Viewer:  http://localhost:${PORT}/`);
  console.log(`  Admin:   http://localhost:${PORT}/?admin   (password: TZH123)\n`);
  console.log(`  Test members: ${STORE.roster.length} on the roster, ${STORE.players.length} ticked in tonight, Round 1 on ${STORE.numCourts} courts (local in-memory data only).`);
  console.log(`  Seeded: session date ${todayIso}; today's regulars = Harvey, Sharmin, Kokyan (Alex already in).`);
  console.log(`  Lucky Draw nights seeded: ${STORE.__seededDrawNights.join(', ')}  ->  http://localhost:${PORT}/#draw\n`);
});
