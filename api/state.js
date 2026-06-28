const { Redis } = require('@upstash/redis');

// Accepts env vars from Vercel Marketplace (KV_REST_API_URL) or direct Upstash (UPSTASH_REDIS_REST_URL)
let redis = null;
try {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) redis = new Redis({ url, token });
} catch (e) {
  console.warn('Redis init skipped:', e.message);
}

const kv = {
  get: async (key) => redis ? redis.get(key) : null,
  set: async (key, val) => {
    if (!redis) throw new Error('No Redis configured');
    return redis.set(key, val);
  },
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'TZH123';
const STATE_KEY = 'court-state';

// Local "today" for the club. Vercel runs in UTC, so without an offset the
// date flips at the wrong moment for non-UTC users (B8). Defaults to UTC+8.
function todayISO() {
  const offsetHours = parseFloat(process.env.TZ_OFFSET_HOURS || '8');
  const d = new Date(Date.now() + offsetHours * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

const DEFAULT_ROSTER = [
  { id: 'p0',  name: 'Thomas',     photo: null, points: 0 },
  { id: 'p1',  name: 'Desmond',    photo: null, points: 0 },
  { id: 'p2',  name: 'Celine 🌸',  photo: null, points: 0 },
  { id: 'p3',  name: 'Sharmin',    photo: null, points: 0 },
  { id: 'p4',  name: 'Terence',    photo: null, points: 0 },
  { id: 'p5',  name: 'Alex',       photo: null, points: 0 },
  { id: 'p6',  name: 'Kokyan',     photo: null, points: 0 },
  { id: 'p7',  name: 'Yit Fung',   photo: null, points: 0 },
  { id: 'p8',  name: 'Ong Yi',     photo: null, points: 0 },
  { id: 'p9',  name: 'Shane',      photo: null, points: 0 },
  { id: 'p10', name: 'Kenn',        photo: null, points: 0 },
  { id: 'p11', name: 'Boon Chuan', photo: null, points: 0 },
  { id: 'p12', name: 'Seng',       photo: null, points: 0 },
  { id: 'p13', name: 'Gp',         photo: null, points: 0 },
  { id: 'p14', name: 'Wei Hao',    photo: null, points: 0 },
  { id: 'p15', name: 'Yao',        photo: null, points: 0 },
  { id: 'p16', name: 'uncle Tan',  photo: null, points: 0 },
  { id: 'p17', name: 'jian',       photo: null, points: 0 },
  { id: 'p18', name: 'dean',       photo: null, points: 0 },
];

const DEFAULT_STATE = {
  roster: DEFAULT_ROSTER,
  players: [],
  numCourts: 2,
  rounds: [],
  currentRound: 0,
  sessionDate: todayISO(),
  sessions: {},
  luckyDraw: { entries: [], drawDate: todayISO(), spin: null, results: [], history: [] },
  monthlyDraw: { month: '', rollSuppressedMonth: '', prizes: ['1 Tube of new G2 Shuttlecock', 'Premium Stringing Service', 'Premium Sports Socks'], participants: [], results: [], spin: null, history: [] },
  shopCustomers: [],
  monthlyDraws: [],
  drawPrizes: ['1 Tube of new G2 Shuttlecock', 'Premium Stringing Service', 'Premium Sports Socks'],
  drawOdds: { first: 0.01, second: 0.03, third: 0.05 },
  monthlySpin: null,
  socialGames: [
    { id: 'sg-fri', day: 'Friday', weekday: 5, time: '9–11pm', enabled: true },
    { id: 'sg-sun', day: 'Sunday', weekday: 0, time: '9–11pm', enabled: true },
    { id: 'sg-mon', day: 'Monday', weekday: 1, time: '9–11pm', enabled: true },
  ],
  signups: [],
};

const DEFAULT_MD_PRIZES = ['1 Tube of new G2 Shuttlecock', 'Premium Stringing Service', 'Premium Sports Socks'];

// Tokens per tubes (1 per 4). Inlined here (not require('../public/monthly-draw.js'))
// to avoid any Vercel function-bundling path surprise — keep it trivial.
function mdDrawTokens(tubes) { return Math.floor((Number(tubes) || 0) / 4); }

// Gracefully migrate the luckyDraw + monthlyDraw sub-objects of an arbitrary (possibly
// old) saved blob to the 2026-06-28 draw-overhaul shape. Additive and tolerant — never
// throws on malformed input; the legacy luckyDraw.lastWinner field is simply ignored.
function normalizeDrawState(current) {
  current = current || {};

  if (!current.luckyDraw || typeof current.luckyDraw !== 'object') {
    current.luckyDraw = { entries: [], drawDate: todayISO(), spin: null, results: [], history: [] };
  }
  {
    const ld = current.luckyDraw;
    if (!Array.isArray(ld.entries)) ld.entries = [];
    if (typeof ld.drawDate !== 'string' || !ld.drawDate) ld.drawDate = todayISO();
    if (!Array.isArray(ld.results)) ld.results = [];
    if (!Array.isArray(ld.history)) ld.history = [];
    if (ld.spin === undefined) ld.spin = null;
    // legacy `lastWinner` (if present) is intentionally ignored
  }

  if (!current.monthlyDraw || typeof current.monthlyDraw !== 'object') {
    current.monthlyDraw = { month: '', rollSuppressedMonth: '', prizes: DEFAULT_MD_PRIZES.slice(), participants: [], results: [], spin: null, history: [] };
  }
  {
    const md = current.monthlyDraw;
    if (!Array.isArray(md.prizes)) md.prizes = DEFAULT_MD_PRIZES.slice();
    if (typeof md.month !== 'string') md.month = '';
    if (typeof md.rollSuppressedMonth !== 'string') md.rollSuppressedMonth = '';
    if (!Array.isArray(md.participants)) md.participants = [];
    md.participants = md.participants.map((p) => {
      p = p || {};
      const tubes = (p.tubes != null) ? (Number(p.tubes) || 0) : ((Number(p.tokens) || 0) * 4);
      return Object.assign({}, p, { tubes, tokens: mdDrawTokens(tubes) });
    });
    if (!Array.isArray(md.results)) md.results = [];
    if (md.spin === undefined) md.spin = null;
    if (!Array.isArray(md.history)) md.history = [];
  }

  return current;
}

const handler = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const state = await kv.get(STATE_KEY);
      const current = state || DEFAULT_STATE;
      normalizeDrawState(current);
      if (!current.roster) current.roster = DEFAULT_ROSTER;
      if (current.roster) current.roster = current.roster.map(r => r.points !== undefined ? r : { ...r, points: 0 });
      if (!Array.isArray(current.shopCustomers)) current.shopCustomers = [];
      if (!Array.isArray(current.monthlyDraws)) current.monthlyDraws = [];
      if (!Array.isArray(current.drawPrizes)) current.drawPrizes = ['1 Tube of new G2 Shuttlecock', 'Premium Stringing Service', 'Premium Sports Socks'];
      if (!current.drawOdds || typeof current.drawOdds !== 'object') current.drawOdds = { first: 0.01, second: 0.03, third: 0.05 };
      if (current.monthlySpin === undefined) current.monthlySpin = null;
      if (!Array.isArray(current.socialGames)) current.socialGames = DEFAULT_STATE.socialGames.map(g => ({ ...g }));
      if (!Array.isArray(current.signups)) current.signups = [];
      if (current.siteCode) {
        const provided = (req.query && req.query.code) ? req.query.code : '';
        if (provided !== current.siteCode) {
          // Still surface the open game days so the locked screen can show its
          // "Join our social games" CTA. Nothing else leaks while locked.
          const openGames = current.socialGames
            .filter(g => g && g.enabled)
            .map(g => ({ id: g.id, day: g.day, weekday: g.weekday, time: g.time, enabled: true }));
          return res.status(200).json({ locked: true, socialGames: openGames });
        }
      }
      return res.json({ ...current, serverTime: Date.now() });
    } catch (e) {
      console.error('KV read error:', e.message);
      return res.json({ ...DEFAULT_STATE, serverTime: Date.now() });
    }
  }

  if (req.method === 'POST') {
    const b = req.body || {};

    // Public, UNAUTHENTICATED sign-up submission. This is the ONLY POST path
    // that does not require the admin password. It can ONLY ever append one
    // sanitized signup — it self-builds the signup object and never spreads
    // req.body into state, so it cannot overwrite siteCode, roster, players,
    // socialGames, etc. It returns in every branch, so a submitSignup request
    // can never fall through to the password-gated update logic below.
    if (b.action === 'submitSignup') {
      // Honeypot: bots fill hidden fields. Pretend success, store nothing.
      if (String(b.hp || '').trim()) return res.json({ ok: true });

      const name = String(b.name == null ? '' : b.name).trim().slice(0, 80);
      const phone = String(b.phone == null ? '' : b.phone).trim().slice(0, 40);
      const days = Array.isArray(b.days)
        ? b.days.slice(0, 7).map(d => String(d == null ? '' : d).slice(0, 20))
        : [];
      if (!name || !phone || !/\d/.test(phone) || days.length === 0) {
        return res.status(400).json({ error: 'Please enter your name, phone and at least one game day.' });
      }

      let s;
      try {
        s = (await kv.get(STATE_KEY)) || { ...DEFAULT_STATE };
      } catch (e) {
        s = { ...DEFAULT_STATE };
      }

      const games = Array.isArray(s.socialGames) ? s.socialGames : DEFAULT_STATE.socialGames;
      const allowed = new Set(games.filter(g => g && g.enabled).map(g => g.day));
      const validDays = days.filter(d => allowed.has(d));
      if (validDays.length === 0) {
        return res.status(400).json({ error: 'Please pick a valid game day.' });
      }

      const signup = {
        id: 'su' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name, phone, days: validDays, at: Date.now(), handled: false,
      };
      const existing = Array.isArray(s.signups) ? s.signups : [];
      // Append-only, newest first, hard-capped at 500 (drop oldest). This slice
      // is the LAST mutation on every append — the array can never grow unbounded.
      s.signups = [signup, ...existing].slice(0, 500);

      try {
        await kv.set(STATE_KEY, s);
      } catch (e) {
        console.error('KV write error (signup):', e.message);
        return res.status(500).json({ error: 'Storage error.' });
      }
      return res.json({ ok: true });
    }

    const { password, ...updates } = req.body || {};

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let state;
    try {
      state = (await kv.get(STATE_KEY)) || { ...DEFAULT_STATE };
    } catch (e) {
      state = { ...DEFAULT_STATE };
    }

    // Auth-only ping (no updates): return state so an authenticated admin can
    // bypass the site lock and reach the admin panel even without the site code.
    if (Object.keys(updates).length === 0) {
      return res.json({ ok: true, state: { ...state, serverTime: Date.now() } });
    }

    // Handle deleteSession action
    if (updates.action === 'deleteSession') {
      const { date } = updates;
      if (state.sessions) delete state.sessions[date];
      try { await kv.set(STATE_KEY, state); } catch (e) { return res.status(500).json({ error: 'Storage error' }); }
      return res.json({ ok: true });
    }

    // Handle updateSession action (edit a historical session)
    if (updates.action === 'updateSession') {
      const { date, session } = updates;
      if (date > todayISO()) return res.status(400).json({ error: 'Cannot create a session for a future date.' });
      state.sessions = { ...(state.sessions || {}), [date]: session };
      try { await kv.set(STATE_KEY, state); } catch (e) { return res.status(500).json({ error: 'Storage error' }); }
      return res.json({ ok: true });
    }

    // Reject future session dates
    if (updates.sessionDate && updates.sessionDate > todayISO()) {
      return res.status(400).json({ error: 'Cannot set a future date.' });
    }

    // Auto-save current session when date changes
    if (updates.sessionDate && updates.sessionDate !== state.sessionDate && state.sessionDate) {
      const snapshot = {
        players: (state.players || []).map(p => ({ id: p.id, name: p.name })),
        rounds: state.rounds || [],
        numCourts: state.numCourts || 1,
        courtRounds: state.courtRounds || [],
      };
      state.sessions = { ...(state.sessions || {}), [state.sessionDate]: snapshot };
      // Prune sessions older than 31 days
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 31);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      for (const d of Object.keys(state.sessions)) {
        if (d < cutoffStr) delete state.sessions[d];
      }
      // Reset session-specific data for the new date
      state.players = [];
      state.rounds = [];
      state.currentRound = 0;
      state.courtRounds = [];
    }

    state = { ...state, ...updates };

    try {
      await kv.set(STATE_KEY, state);
    } catch (e) {
      console.error('KV write error:', e.message);
      return res.status(500).json({ error: 'Storage error. Add Upstash Redis from Vercel Marketplace and link it to this project.' });
    }

    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports = handler;
module.exports.normalizeDrawState = normalizeDrawState;
