// Vercel Cron target — runs the Weekly Lucky Draw auto-draw sweep.
//
// vercel.json schedules this daily at "0 12 * * *" (12:00 UTC = 20:00 Malaysia
// time, the default draw time). runWeeklyDrawSweep() is idempotent — it only
// draws sessions whose configured draw time has passed and that aren't already
// drawn — so a daily run self-heals a missed day and each Mon/Fri/Sun session is
// drawn once, on its own schedule. A duplicate/late invocation is harmless.
//
// Optional hardening: set CRON_SECRET and Vercel sends `Authorization: Bearer
// <secret>`; when set we require it. Without it the endpoint is still safe (it
// can only ever pick a winner from an already-eligible list).
const { runWeeklyDrawSweep } = require('./state.js');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  try {
    const result = await runWeeklyDrawSweep();
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    console.error('cron-weekly-draw error:', e && e.message);
    return res.status(500).json({ error: 'Weekly draw failed' });
  }
};
