// Vercel Cron target — advances the session date at 00:00 Malaysia time.
//
// vercel.json schedules this at "0 16 * * *" (16:00 UTC = 00:00 UTC+8). The
// server's todayISO() already uses TZ_OFFSET_HOURS (default 8), so the day
// boundary is Malaysia's. rolloverSessionDate() is idempotent — a no-op unless
// the live session date is stale — so a duplicate/late invocation is harmless.
//
// Optional hardening: set a CRON_SECRET env var and Vercel will send
// `Authorization: Bearer <secret>`; when set, we require it. Without it the
// endpoint is still safe (it can only ever advance a stale date to *today*).
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
