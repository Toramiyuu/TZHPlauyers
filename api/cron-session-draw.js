// Vercel Cron target — runs the per-session Lucky Draw sweep.
//
// vercel.json schedules this at "0 1 * * *" (01:00 UTC = 09:00 Malaysia time,
// the fixed draw time). On the Hobby plan Vercel fires it anywhere between
// 09:00 and 09:59; that is fine because eligibility is judged against the
// STORED scheduled draw time (09:00), not the moment the job happens to run.
// runSessionDrawSweep() is idempotent — it only writes a result for sessions
// whose draw time has passed and that have none yet (HSETNX), so a duplicate,
// late or manual invocation is harmless and a missed day self-heals.
//
// Optional hardening: set CRON_SECRET and Vercel sends `Authorization: Bearer
// <secret>`; when set we require it. Without it the endpoint is still safe (it
// can only ever draw an already-due session exactly once).
const { runSessionDrawSweep } = require('./state.js');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  try {
    const result = await runSessionDrawSweep();
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    console.error('cron-session-draw error:', e && e.message);
    return res.status(500).json({ error: 'Session draw failed' });
  }
};
