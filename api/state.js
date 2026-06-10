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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const DEFAULT_ROSTER = [
  { id: 'p0',  name: 'Thomas',     photo: null },
  { id: 'p1',  name: 'Desmond',    photo: null },
  { id: 'p2',  name: 'Celine 🌸',  photo: null },
  { id: 'p3',  name: 'Sharmin',    photo: null },
  { id: 'p4',  name: 'Terence',    photo: null },
  { id: 'p5',  name: 'Alex',       photo: null },
  { id: 'p6',  name: 'Kokyan',     photo: null },
  { id: 'p7',  name: 'Yit Fung',   photo: null },
  { id: 'p8',  name: 'Ong Yi',     photo: null },
  { id: 'p9',  name: 'Shane',      photo: null },
  { id: 'p10', name: 'Kenn 4',     photo: null },
  { id: 'p11', name: 'Boon Chuan', photo: null },
  { id: 'p12', name: 'Kenn 5',     photo: null },
  { id: 'p13', name: 'Gp',         photo: null },
  { id: 'p14', name: 'Wei Hao',    photo: null },
  { id: 'p15', name: 'Yao',        photo: null },
  { id: 'p16', name: 'uncle Tan',  photo: null },
  { id: 'p17', name: 'jian',       photo: null },
  { id: 'p18', name: 'dean',       photo: null },
];

const DEFAULT_STATE = {
  roster: DEFAULT_ROSTER,
  players: [],
  numCourts: 2,
  rounds: [],
  currentRound: 0,
  sessionDate: todayISO(),
  sessions: {},
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
      if (current.siteCode) {
        const provided = (req.query && req.query.code) ? req.query.code : '';
        if (provided !== current.siteCode) {
          return res.status(200).json({ locked: true });
        }
      }
      return res.json(current);
    } catch (e) {
      console.error('KV read error:', e.message);
      return res.json(DEFAULT_STATE);
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

    // Handle updateSession action (edit a historical session)
    if (updates.action === 'updateSession') {
      const { date, session } = updates;
      state.sessions = { ...(state.sessions || {}), [date]: session };
      try { await kv.set(STATE_KEY, state); } catch (e) { return res.status(500).json({ error: 'Storage error' }); }
      return res.json({ ok: true });
    }

    // Auto-save current session when date changes
    if (updates.sessionDate && updates.sessionDate !== state.sessionDate && state.sessionDate) {
      const snapshot = {
        players: (state.players || []).map(p => ({ id: p.id, name: p.name })),
        rounds: state.rounds || [],
        numCourts: state.numCourts || 1,
      };
      state.sessions = { ...(state.sessions || {}), [state.sessionDate]: snapshot };
      // Prune sessions older than 31 days
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 31);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      for (const d of Object.keys(state.sessions)) {
        if (d < cutoffStr) delete state.sessions[d];
      }
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
