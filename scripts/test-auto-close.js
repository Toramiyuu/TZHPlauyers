#!/usr/bin/env node
/*
 * test-auto-close.js — guard for the automatic "End of the day".
 *
 * The treasurer leaves the hall at 12:30am and goes to sleep, so the End-of-the-day
 * button usually never gets pressed on the night itself. Without a payment record
 * per player there is nothing to tick off the next afternoon, and the session draw
 * three days later sees zero paid players. autoCloseNight() (api/state.js) generates
 * the unpaid records from the 09:00 MYT cron instead.
 *
 * What is asserted here:
 *   - it creates one unpaid record per player in the current night's line-up;
 *   - it NEVER marks anyone paid and NEVER moves the session date;
 *   - it is idempotent (a second run, and a run after the admin pressed the button
 *     themselves, both change nothing);
 *   - it leaves PAST nights alone — only ever the live one;
 *   - the small hours still belong to the night that started: at 09:00 Saturday it
 *     closes FRIDAY, not Saturday (see public/night.js);
 *   - a cron close is attributed 'auto', a button press 'admin', so the audit log
 *     tells them apart;
 *   - it self-heals: a cron that never fired on Saturday still closes Friday when
 *     Sunday morning's run comes round.
 *   - api/cron-session-draw.js calls it BEFORE the draw sweep.
 */
'use strict';
process.env.ADMIN_PASSWORD = 'TZH123';
process.env.TZ_OFFSET_HOURS = '8';
let STORE = null;
const HASHES = new Map();
require.cache[require.resolve('@upstash/redis')] = {
  id: require.resolve('@upstash/redis'), loaded: true,
  exports: { Redis: class {
    async get() { return STORE; }
    async set(_k, v) { STORE = v; return 'OK'; }
    async hget(k, f) { const h = HASHES.get(k); return h && h.has(f) ? h.get(f) : null; }
    async hgetall(k) { const h = HASHES.get(k); if (!h || !h.size) return null; return Object.fromEntries(h); }
    async hsetnx(k, f, v) { let h = HASHES.get(k); if (!h) { h = new Map(); HASHES.set(k, h); } if (h.has(f)) return 0; h.set(f, String(v)); return 1; }
    async hset(k, kv) { let h = HASHES.get(k); if (!h) { h = new Map(); HASHES.set(k, h); } for (const f of Object.keys(kv || {})) h.set(f, String(kv[f])); return 1; }
  } },
};
process.env.KV_REST_API_URL = 'http://stub';
process.env.KV_REST_API_TOKEN = 'stub';

const fs = require('fs');
const path = require('path');
const { autoCloseNight } = require('../api/state.js');
const { handlePaymentAdminAction } = require('../lib/payments.js');
const Night = require('../public/night.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

// Fri 2026-09-04 is a game day; Sat 2026-09-05 is not, so it belongs to Friday.
const FRI = '2026-09-04';
const PREV = '2026-09-01';   // the Monday before — a past night, already settled
// Local MYT hour `h` on Sat 5 Sep / Sun 6 Sep, as an epoch ms (MYT = UTC+8).
const satAt = (h) => Date.parse('2026-09-05T00:00:00Z') + (h - 8) * 3600 * 1000;
const sunAt = (h) => Date.parse('2026-09-06T00:00:00Z') + (h - 8) * 3600 * 1000;

const roster = [
  { id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' },
  { id: 'p3', name: 'Cara' }, { id: 'p4', name: 'Dan' },
];
function freshState(over) {
  return Object.assign({
    roster: roster.map(p => ({ ...p })),
    players: roster.map(p => ({ ...p })),   // tonight's ticked line-up
    sessionDate: FRI,
    sessions: {},
    attendance: {},
    feeTier: '3h',
    audit: [],
    signups: [], regulars: {},
  }, over || {});
}
const entriesOf = (s, d) => Object.values(((s.attendance || {})[d] || {}).entries || {});
const withPayment = (s, d) => entriesOf(s, d).filter(e => e && e.payment);

// ── the night boundary this whole feature rests on ──
check('09:00 Saturday still belongs to Friday night', Night.currentNight(satAt(9), 8) === FRI);
check('02:00 Saturday (the small hours) is still Friday night', Night.currentNight(satAt(2), 8) === FRI);
check('09:00 Sunday is still Friday — Sunday only takes over at 20:00', Night.currentNight(sunAt(9), 8) === FRI);

(async () => {
  // ── the normal case: nobody pressed the button ──
  STORE = freshState();
  let r = await autoCloseNight({ nowMs: satAt(9) });
  check('auto-close reports a change', r.ok === true && r.changed === true);
  check('auto-close closes FRIDAY, not Saturday', r.night === FRI);
  check('one record per player in the line-up', withPayment(STORE, FRI).length === 4 && r.created === 4);
  check('nobody is marked paid', withPayment(STORE, FRI).every(e => !e.paid));
  check('no paidAt is stamped', withPayment(STORE, FRI).every(e => !e.payment.paidAt));
  check('the session date is untouched', STORE.sessionDate === FRI);
  check('the day carries its generated stamp', !!(STORE.attendance[FRI].payments || {}).generatedAt);
  check('a cron close is attributed to "auto"', STORE.attendance[FRI].payments.generatedBy === 'auto');
  check('the audit entry is attributed to "auto"',
    (STORE.audit || []).some(a => a.action === 'payments.generate' && a.admin === 'auto'));

  // ── idempotent: running it again changes nothing ──
  const snapshot = JSON.stringify(STORE);
  r = await autoCloseNight({ nowMs: satAt(9) + 3600 * 1000 });
  check('a second run reports no change', r.ok === true && r.changed === false);
  check('a second run rewrites nothing', JSON.stringify(STORE) === snapshot);

  // ── self-healing: a cron that never fired on Saturday still closes Friday on Sunday morning ──
  STORE = freshState();
  r = await autoCloseNight({ nowMs: sunAt(9) });
  check('a missed day self-heals on the next morning run', r.changed === true && r.night === FRI);
  check('the self-healed close still lands on Friday', withPayment(STORE, FRI).length === 4);

  // ── the admin pressed the button first: the cron must not double up ──
  STORE = freshState();
  const manual = handlePaymentAdminAction(STORE, { action: 'generatePayments', date: FRI }, { nowMs: satAt(1) });
  check('the button still attributes to "admin"', STORE.attendance[FRI].payments.generatedBy === 'admin');
  check('the button created the four records', manual.body.created === 4);
  const afterManual = JSON.stringify(STORE);
  r = await autoCloseNight({ nowMs: satAt(9) });
  check('the cron is a no-op after a manual press', r.changed === false && JSON.stringify(STORE) === afterManual);
  check('the manual attribution survives the cron run', STORE.attendance[FRI].payments.generatedBy === 'admin');

  // ── an already-paid player must never be un-paid or re-charged ──
  STORE = freshState();
  await autoCloseNight({ nowMs: satAt(9) });
  handlePaymentAdminAction(STORE, { action: 'setPayment', date: FRI, playerId: 'p1', paid: true, method: 'cash' }, { nowMs: satAt(10) });
  check('a player can be settled after the auto-close', STORE.attendance[FRI].entries.p1.paid === true);
  const paidAt = STORE.attendance[FRI].entries.p1.payment.paidAt;
  r = await autoCloseNight({ nowMs: sunAt(9) });
  check('a later cron run leaves the settled player paid',
    STORE.attendance[FRI].entries.p1.paid === true && STORE.attendance[FRI].entries.p1.payment.paidAt === paidAt);

  // ── past nights are none of this job's business ──
  STORE = freshState({ sessionDate: FRI, sessions: { [PREV]: { players: roster.map(p => ({ ...p })) } } });
  await autoCloseNight({ nowMs: satAt(9) });
  check('an older night is not closed by this run', withPayment(STORE, PREV).length === 0);

  // ── a session date that is not the current night is skipped entirely ──
  STORE = freshState({ sessionDate: PREV });
  r = await autoCloseNight({ nowMs: satAt(9) });
  check('a stale session date is refused, not force-closed', r.changed === false && withPayment(STORE, PREV).length === 0);

  // ── an empty line-up: nothing to generate, and that is not an error ──
  STORE = freshState({ players: [] });
  r = await autoCloseNight({ nowMs: satAt(9) });
  check('an empty line-up generates nothing without erroring', r.ok === true && r.changed === false);
  check('an empty line-up writes no attendance day', withPayment(STORE, FRI).length === 0);

  // ── the cron must actually call it, and before the draw sweep ──
  const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron-session-draw.js'), 'utf8');
  check('the 09:00 cron calls autoCloseNight', /await autoCloseNight\(/.test(cronSrc));
  check('it closes the night BEFORE running the draw sweep',
    cronSrc.indexOf('await autoCloseNight(') < cronSrc.indexOf('await runSessionDrawSweep()'));
  check('a close failure cannot block the draws', /try \{ closed = await autoCloseNight\(\); \} catch/.test(cronSrc));

  console.log(`auto-close: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error('auto-close tests threw:', e); process.exit(1); });
