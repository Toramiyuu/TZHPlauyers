const { kv } = require('@vercel/kv');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'TZH123';
const STATE_KEY = 'court-state';

const DEFAULT_STATE = {
  players: [
    { id: 'p0', name: 'Player 1', photo: null },
    { id: 'p1', name: 'Player 2', photo: null },
    { id: 'p2', name: 'Player 3', photo: null },
    { id: 'p3', name: 'Player 4', photo: null },
    { id: 'p4', name: 'Player 5', photo: null },
    { id: 'p5', name: 'Player 6', photo: null },
    { id: 'p6', name: 'Player 7', photo: null },
    { id: 'p7', name: 'Player 8', photo: null },
  ],
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
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const state = await kv.get(STATE_KEY);
      return res.json(state || DEFAULT_STATE);
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

    state = { ...state, ...updates };

    try {
      await kv.set(STATE_KEY, state);
    } catch (e) {
      console.error('KV write error:', e.message);
      return res.status(500).json({ error: 'Storage error. Ensure Vercel KV is linked to this project.' });
    }

    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
