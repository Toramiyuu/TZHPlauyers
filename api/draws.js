// GET /api/draws?code=XXX-XXX[&limit=40][&before=YYYY-MM-DD]
//
// The public Lucky Draw page. Gated by the daily site code exactly like
// GET /api/state. Before building the list it runs the idempotent draw sweep,
// so the first person who opens the page after a scheduled draw time triggers
// that draw (Vercel Hobby crons fire anywhere within the hour — this makes the
// result visible at 09:00 sharp for whoever looks first). The sweep only ever
// writes a missing result with HSETNX; it never touches court-state.
const S = require('./state.js');
const { sweepSessionDraws, buildDrawsView } = require('./session-draw.js');
const SD = require('../public/session-draw.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let state;
  try {
    state = await S.loadState();
  } catch (e) {
    return res.status(500).json({ error: 'Storage error.' });
  }
  if (state.siteCode) {
    const provided = (req.query && req.query.code) ? req.query.code : '';
    if (provided !== state.siteCode) return res.status(200).json({ locked: true, today: S.todayISO() });
  }
  let results = null;
  try {
    results = (await sweepSessionDraws(state, S.drawStore, {})).results;
  } catch (e) {
    console.error('draws sweep error:', e && e.message);
  }
  try {
    const q = req.query || {};
    const limit = Number(q.limit);
    const view = await buildDrawsView(state, S.drawStore, {
      results, limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : undefined, before: q.before,
    });
    // Public projection: winners (+ eligible names once drawn, for the replay) —
    // never who attended, who paid, or when. The admin list keeps the full view.
    return res.json(Object.assign({ ok: true }, view, { sessions: (view.sessions || []).map(SD.publicSessionView), today: S.todayISO(), serverTime: Date.now() }));
  } catch (e) {
    console.error('draws view error:', e && e.message);
    return res.status(500).json({ error: 'Could not load the draws.' });
  }
};
