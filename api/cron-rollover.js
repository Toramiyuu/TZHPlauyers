// Vercel Cron target — advances the session date to the new NIGHT at 20:00
// Malaysia time. Not midnight: see public/night.js. A night belongs to the day
// it started, so the Friday social that ends at 12:30am is still Friday, and so
// is the Saturday afternoon spent tallying its payments.
//
// vercel.json schedules this at "0 12 * * *" (12:00 UTC = 20:00 UTC+8) — the
// hour a game night takes over. On the four non-game days the current night is
// unchanged, so this is a no-op. rolloverSessionDate() is idempotent (a no-op
// unless the session date is behind the current night), so a duplicate or late
// invocation is harmless.
//
// Optional hardening: set a CRON_SECRET env var and Vercel will send
// `Authorization: Bearer <secret>`; when set, we require it. Without it the
// endpoint is still safe (it can only ever advance a stale date to the current
// night, which is always a Mon/Fri/Sun game day).
const { rolloverSessionDate } = require('./state.js');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  try {
    const result = await rolloverSessionDate();
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    console.error('cron-rollover error:', e && e.message);
    return res.status(500).json({ error: 'Rollover failed' });
  }
};
