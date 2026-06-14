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
  luckyDraw: { entries: [], spin: null, lastWinner: null, history: [] },
  monthlyDraw: { prizes: ['1 Tube of new G2 Shuttlecock', 'Premium Stringing Service', 'Premium Sports Socks'], participants: [], results: [], spin: null, history: [] },
  shopCustomers: [],
  monthlyDraws: [],
  drawPrizes: ['1 Tube of new G2 Shuttlecock', 'Premium Stringing Service', 'Premium Sports Socks'],
  drawOdds: { first: 0.01, second: 0.03, third: 0.05 },
  monthlySpin: null,
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const state = await kv.get(STATE_KEY);
      const current = state || DEFAULT_STATE;
      if (!current.luckyDraw) current.luckyDraw = { entries: [], spin: null, lastWinner: null, history: [] };
      if (current.luckyDraw.lastWinner === undefined) current.luckyDraw.lastWinner = null;
      if (!current.luckyDraw.history) current.luckyDraw.history = [];
      if (!current.monthlyDraw) current.monthlyDraw = { prizes: ['1 Tube of new G2 Shuttlecock', 'Premium Stringing Service', 'Premium Sports Socks'], participants: [], results: [], spin: null, history: [] };
      {
        const md = current.monthlyDraw;
        if (!Array.isArray(md.prizes)) md.prizes = ['1 Tube of new G2 Shuttlecock', 'Premium Stringing Service', 'Premium Sports Socks'];
        if (!Array.isArray(md.participants)) md.participants = [];
        if (!Array.isArray(md.results)) md.results = [];
        if (md.spin === undefined) md.spin = null;
        if (!Array.isArray(md.history)) md.history = [];
      }
      if (!current.roster) current.roster = DEFAULT_ROSTER;
      if (current.roster) current.roster = current.roster.map(r => r.points !== undefined ? r : { ...r, points: 0 });
      if (!Array.isArray(current.shopCustomers)) current.shopCustomers = [];
      if (!Array.isArray(current.monthlyDraws)) current.monthlyDraws = [];
      if (!Array.isArray(current.drawPrizes)) current.drawPrizes = ['1 Tube of new G2 Shuttlecock', 'Premium Stringing Service', 'Premium Sports Socks'];
      if (!current.drawOdds || typeof current.drawOdds !== 'object') current.drawOdds = { first: 0.01, second: 0.03, third: 0.05 };
      if (current.monthlySpin === undefined) current.monthlySpin = null;
      if (current.siteCode) {
        const provided = (req.query && req.query.code) ? req.query.code : '';
        if (provided !== current.siteCode) {
          return res.status(200).json({ locked: true });
        }
      }
      return res.json({ ...current, serverTime: Date.now() });
    } catch (e) {
      console.error('KV read error:', e.message);
      return res.json({ ...DEFAULT_STATE, serverTime: Date.now() });
    }
  }

  if (req.method === 'POST') {
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
