const express = require('express');
const path = require('path');
const os = require('os');
// Reuse the serverless submit validator + clock so local dev matches production.
const { buildSignups, todayISO, applySessionDateChange, publicProjection } = require('./api/state.js');
const { ACCOUNT_ACTIONS, handleAccountAction, redactState, ADMIN_ACCOUNT_ACTIONS, handleAdminAccountAction } = require('./api/accounts.js');
const { WEEKLY_ADMIN_ACTIONS, handleWeeklyAdminAction } = require('./api/weekly.js');
const { PAYMENT_ADMIN_ACTIONS, handlePaymentAdminAction } = require('./api/payments.js');
const { SESSION_DRAW_ADMIN_ACTIONS, handleSessionDrawAdminAction, sweepSessionDraws, buildDrawsView, memoryDrawStore } = require('./api/session-draw.js');
const { MONTHLY_LUCKY_ADMIN_ACTIONS, handleMonthlyLuckyAdminAction, sweepMonthlyDraws, buildMonthlyView, memoryMonthlyStore } = require('./api/monthly-lucky.js');
const ML = require('./public/monthly-lucky.js');
const Payments = require('./public/payments.js');
const SD = require('./public/session-draw.js');

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
  sessionDate: todayISO(),
  sessions: {},
  feeTier: Payments.DEFAULT_TIER,
  luckyDraw: { entries: [], paid: [], drawDate: null, spin: null, results: [], history: [] },
  monthlyDraw: { month: '', rollSuppressedMonth: '', prizes: ['1 Tube of new G2 Shuttlecock', 'Premium Stringing Service', 'Premium Sports Socks'], participants: [], results: [], spin: null, history: [] },
  socialGames: [
    { id: 'sg-fri', day: 'Friday', weekday: 5, time: '9–11pm', enabled: true },
    { id: 'sg-sun', day: 'Sunday', weekday: 0, time: '9–11pm', enabled: true },
    { id: 'sg-mon', day: 'Monday', weekday: 1, time: '9–11pm', enabled: true },
  ],
  signups: [],
  regulars: {}, // weekday (0=Sun..6=Sat) -> roster ids who always come that day
  attendance: {},
  drawSettings: { winners: SD.DEFAULT_WINNERS },
  sessionDrawAt: SD.scheduledDrawAt(todayISO()),
  monthlyEligibility: null,
  audit: [],
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
// Session draw results (permanent; in-memory for local dev — see api/session-draw.js).
const drawStore = memoryDrawStore();
const monthlyStore = memoryMonthlyStore();

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
      return res.json({ locked: true, socialGames: openGames, today: todayISO() });
    }
  }
  // publicProjection strips accounts + private attendance/audit/eligibility,
  // matching production.
  res.json({ ...publicProjection(state), serverTime: Date.now(), today: todayISO() });
});

// GET draws — the public Lucky Draw page (site-code gated), same as api/draws.js.
app.get('/api/draws', async (req, res) => {
  if (state.siteCode && (req.query.code || '') !== state.siteCode) return res.json({ locked: true, today: todayISO() });
  let results = null;
  try { results = (await sweepSessionDraws(state, drawStore, {})).results; } catch (e) { /* view still loads */ }
  const limit = Number(req.query.limit);
  const view = await buildDrawsView(state, drawStore, { results, limit: Number.isInteger(limit) && limit > 0 ? limit : undefined, before: req.query.before });
  let monthly = null;
  try {
    const mres = (await sweepMonthlyDraws(state, monthlyStore, {})).results;
    const mv = await buildMonthlyView(state, monthlyStore, { results: mres });
    monthly = { auto: mv.settings.auto, winners: mv.settings.winners, threshold: mv.settings.threshold, pointsMonth: mv.pointsMonth, prizes: mv.settings.prizes, months: (mv.months || []).map(ML.publicMonthView) };
  } catch (e) { /* view still loads */ }
  res.json({ ok: true, ...view, sessions: (view.sessions || []).map(SD.publicSessionView), monthly, today: todayISO(), serverTime: Date.now() });
});

// POST state — admin only, merges updates
app.post('/api/state', async (req, res) => {
  const b = req.body || {};

  // Public, UNAUTHENTICATED sign-up submission. This is the ONLY POST path that
  // does not require the admin password. It self-builds one sanitized signup
  // and never spreads req.body into state, so it cannot overwrite siteCode,
  // roster, players, socialGames, etc. It returns in every branch, so a
  // submitSignup request never falls through to the password-gated logic below.
  if (b.action === 'submitSignup') {
    if (String(b.hp || '').trim()) return res.json({ ok: true }); // honeypot

    // Same validator as api/state.js: self-builds one sanitized signup per
    // person (group sign-up shares one date set), never spreads req.body.
    const built = buildSignups(b, { socialGames: state.socialGames, todayISO: todayISO() });
    if (!built.ok) return res.status(400).json({ error: built.error || 'Please complete the form.' });

    const at = Date.now(); // one timestamp for the group so its rows sort adjacently
    const stamped = built.list.map((fields, i) => Object.assign(
      { id: 'su' + at.toString(36) + i.toString(36) + Math.random().toString(36).slice(2, 6), at, handled: false },
      fields
    ));
    const existing = Array.isArray(state.signups) ? state.signups : [];
    state.signups = [...stamped, ...existing].slice(0, 500); // append-only, cap 500
    return res.json({ ok: true });
  }

  // Public, UNAUTHENTICATED account actions (register / login / session /
  // update profile / logout) — same contract as api/state.js: returns in every
  // branch, never reaches the admin-password logic, only ever touches the
  // accounts array and the roster player it owns.
  if (b.action && ACCOUNT_ACTIONS.has(b.action)) {
    const result = handleAccountAction(state, b);
    return res.status(result.status).json(result.body);
  }

  const { password, ...updates } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Auth-only ping (no updates): return state so an authenticated admin can
  // bypass the site lock and reach the admin panel even without the site code.
  if (Object.keys(updates).length === 0) {
    return res.json({ ok: true, state: { ...redactState(state), serverTime: Date.now() } });
  }
  // Admin account-management actions (approve / reject / reveal / lock / ...).
  if (updates.action && ADMIN_ACCOUNT_ACTIONS.has(updates.action)) {
    const result = handleAdminAccountAction(state, updates, { adminPassword: ADMIN_PASSWORD });
    return res.status(result.status).json(result.body);
  }
  // Admin attendance / monthly-eligibility actions.
  if (updates.action && WEEKLY_ADMIN_ACTIONS.has(updates.action)) {
    const result = handleWeeklyAdminAction(state, updates);
    return res.status(result.status).json(result.body);
  }
  // Admin per-player session payment actions (End of the day / paid toggles).
  if (updates.action && PAYMENT_ADMIN_ACTIONS.has(updates.action)) {
    const result = handlePaymentAdminAction(state, updates);
    return res.status(result.status).json(result.body);
  }
  // Admin session-draw actions (Run draw now / winners setting / admin draw list).
  if (updates.action && SESSION_DRAW_ADMIN_ACTIONS.has(updates.action)) {
    const result = await handleSessionDrawAdminAction(state, updates, { store: drawStore });
    return res.status(result.status).json(result.body);
  }
  // Admin Monthly (points) draw actions (settings / prizes / pool / Run draw now / list).
  if (updates.action && MONTHLY_LUCKY_ADMIN_ACTIONS.has(updates.action)) {
    const result = await handleMonthlyLuckyAdminAction(state, updates, { store: monthlyStore });
    return res.status(result.status).json(result.body);
  }
  // Admin fetch of the full private ops data (kept out of public GET).
  if (updates.action === 'adminGetOps') {
    return res.json({
      ok: true,
      attendance: state.attendance || {},
      drawSettings: { winners: SD.winnersOf(state.drawSettings) },
      monthlyEligibility: state.monthlyEligibility || null,
      audit: Array.isArray(state.audit) ? state.audit.slice(0, 300) : [],
      feeTier: Payments.tierOf(state.feeTier),
      sessionDate: state.sessionDate || null,
    });
  }
  if (updates.action !== undefined) {
    return res.status(400).json({ error: 'Unknown action.' });
  }
  if (updates.feeTier !== undefined && !Payments.isTier(updates.feeTier)) {
    return res.status(400).json({ error: 'Invalid fee tier.' });
  }
  if (updates.drawSettings !== undefined || updates.sessionDrawAt !== undefined) {
    return res.status(400).json({ error: 'Use the setDrawSettings action.' });
  }
  if (updates.monthlyLucky !== undefined) {
    return res.status(400).json({ error: 'Use the monthly draw actions.' });
  }
  // Session-date change uses the SAME shared logic as production (api/state.js)
  // so local dev reproduces the snapshot/restore/one-month-ahead behaviour.
  if (updates.sessionDate) {
    const transition = applySessionDateChange(state, updates.sessionDate);
    if (!transition.ok) return res.status(400).json({ error: transition.error });
    state = transition.state;
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
