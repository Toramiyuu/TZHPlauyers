const express = require('express');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '50mb' })); // large limit for base64 photos
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'TZH123';

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

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));

// GET state — public
app.get('/api/state', (req, res) => {
  res.json(state);
});

// POST state — admin only, merges updates
app.post('/api/state', (req, res) => {
  const { password, ...updates } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
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
