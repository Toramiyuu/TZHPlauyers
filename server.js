const express = require('express');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '50mb' })); // large limit for base64 photos
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'TZH123';

const DEFAULT_STATE = {
  roster: [
    { id: 'p0', name: 'Thomas',     photo: null, points: 0 },
    { id: 'p1', name: 'Desmond',    photo: null, points: 0 },
    { id: 'p2', name: 'Celine',     photo: null, points: 0 },
    { id: 'p3', name: 'Sharmin',    photo: null, points: 0 },
    { id: 'p4', name: 'Terence',    photo: null, points: 0 },
    { id: 'p5', name: 'Alex',       photo: null, points: 0 },
    { id: 'p6', name: 'Kokyan',     photo: null, points: 0 },
    { id: 'p7', name: 'Yit Fung',   photo: null, points: 0 },
  ],
  players: [],
  numCourts: 2,
  rounds: [
    {
      label: 'Round 1',
      courts: [
        { team1: ['p0', 'p1'], team2: ['p2', 'p3'] },
        { team1: ['p4', 'p5'], team2: ['p6', 'p7'] },
      ],
    },
  ],
  currentRound: 0,
  luckyDraw: { entries: [], drawDate: null, spin: null, results: [], history: [] },
  monthlyDraw: { month: '', rollSuppressedMonth: '', prizes: ['1 Tube of new G2 Shuttlecock', 'Premium Stringing Service', 'Premium Sports Socks'], participants: [], results: [], spin: null, history: [] },
  socialGames: [
    { id: 'sg-fri', day: 'Friday', weekday: 5, time: '9–11pm', enabled: true },
    { id: 'sg-sun', day: 'Sunday', weekday: 0, time: '9–11pm', enabled: true },
    { id: 'sg-mon', day: 'Monday', weekday: 1, time: '9–11pm', enabled: true },
  ],
  signups: [],
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));

// GET state — public (with siteCode gate)
app.get('/api/state', (req, res) => {
  if (state.siteCode) {
    const provided = req.query.code || '';
    if (provided !== state.siteCode) {
      // Surface only the open game days so the locked screen can show its CTA.
      const games = Array.isArray(state.socialGames) ? state.socialGames : [];
      const openGames = games
        .filter(g => g && g.enabled)
        .map(g => ({ id: g.id, day: g.day, weekday: g.weekday, time: g.time, enabled: true }));
      return res.json({ locked: true, socialGames: openGames });
    }
  }
  res.json({ ...state, serverTime: Date.now() });
});

// POST state — admin only, merges updates
app.post('/api/state', (req, res) => {
  const b = req.body || {};

  // Public, UNAUTHENTICATED sign-up submission. This is the ONLY POST path that
  // does not require the admin password. It self-builds one sanitized signup
  // and never spreads req.body into state, so it cannot overwrite siteCode,
  // roster, players, socialGames, etc. It returns in every branch, so a
  // submitSignup request never falls through to the password-gated logic below.
  if (b.action === 'submitSignup') {
    if (String(b.hp || '').trim()) return res.json({ ok: true }); // honeypot

    const name = String(b.name == null ? '' : b.name).trim().slice(0, 80);
    const phone = String(b.phone == null ? '' : b.phone).trim().slice(0, 40);
    const days = Array.isArray(b.days)
      ? b.days.slice(0, 7).map(d => String(d == null ? '' : d).slice(0, 20))
      : [];
    if (!name || !phone || !/\d/.test(phone) || days.length === 0) {
      return res.status(400).json({ error: 'Please enter your name, phone and at least one game day.' });
    }

    const games = Array.isArray(state.socialGames) ? state.socialGames : DEFAULT_STATE.socialGames;
    const allowed = new Set(games.filter(g => g && g.enabled).map(g => g.day));
    const validDays = days.filter(d => allowed.has(d));
    if (validDays.length === 0) {
      return res.status(400).json({ error: 'Please pick a valid game day.' });
    }

    const signup = {
      id: 'su' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, phone, days: validDays, at: Date.now(), handled: false,
    };
    const existing = Array.isArray(state.signups) ? state.signups : [];
    state.signups = [signup, ...existing].slice(0, 500); // append-only, cap 500
    return res.json({ ok: true });
  }

  const { password, ...updates } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Auth-only ping (no updates): return state so an authenticated admin can
  // bypass the site lock and reach the admin panel even without the site code.
  if (Object.keys(updates).length === 0) {
    return res.json({ ok: true, state: { ...state, serverTime: Date.now() } });
  }
  state = { ...state, ...updates };
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIp = 'localhost';
  for (const iface of Object.values(interfaces)) {
    for (const entry of iface) {
      if (entry.family === 'IPv4' && !entry.internal) { localIp = entry.address; break; }
    }
    if (localIp !== 'localhost') break;
  }
  console.log(`\n  Court Display running!\n`);
  console.log(`  Viewer:  http://${localIp}:${PORT}/`);
  console.log(`  Admin:   http://${localIp}:${PORT}/?admin\n`);
});
