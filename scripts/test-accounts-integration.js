#!/usr/bin/env node
/* Integration tests through the REAL api/state.js POST dispatcher (with an
 * in-memory Redis stub, like dev-server.js). This exercises the `{password,
 * ...updates}` strip that unit tests bypass — it's what caught the reveal /
 * create-account field-name collision with the admin-auth `password` field. */
'use strict';
const crypto = require('crypto');
process.env.ACCOUNT_ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.ADMIN_PASSWORD = 'TZH123';

// Stub @upstash/redis BEFORE requiring the handler. HASHES backs the two draw
// result hashes (court-draws / court-monthly-draws) that memberInfo reads.
let STORE = null;
const HASHES = new Map();
require.cache[require.resolve('@upstash/redis')] = {
  id: require.resolve('@upstash/redis'), loaded: true,
  exports: { Redis: class {
    async get() { return STORE; } async set(_k, v) { STORE = v; return 'OK'; }
    async hget(k, f) { const h = HASHES.get(k); return h && h.has(f) ? h.get(f) : null; }
    async hgetall(k) { const h = HASHES.get(k); if (!h || !h.size) return null; return Object.fromEntries(h); }
    async hsetnx(k, f, v) { let h = HASHES.get(k); if (!h) { h = new Map(); HASHES.set(k, h); } if (h.has(f)) return 0; h.set(f, String(v)); return 1; }
    async hset(k, kv) { let h = HASHES.get(k); if (!h) { h = new Map(); HASHES.set(k, h); } for (const f of Object.keys(kv || {})) h.set(f, String(kv[f])); return 1; }
  } },
};
process.env.KV_REST_API_URL = 'http://stub';
process.env.KV_REST_API_TOKEN = 'stub';
const handler = require('../api/state.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

function call(method, query, body) {
  return new Promise((resolve) => {
    const res = {
      setHeader() {}, _c: 200,
      status(c) { this._c = c; return this; },
      json(o) { resolve({ status: this._c, body: o }); },
      end() { resolve({ status: this._c, body: null }); },
    };
    handler({ method, query: query || {}, body: body || {} }, res);
  });
}
const P = 'TZH123';
const post = (b) => call('POST', {}, b);

(async () => {
  STORE = {
    roster: [{ id: 'p6', name: 'Kokyan', photo: null, points: 0 }, { id: 'p0', name: 'Thomas', photo: null, points: 0 }],
    players: [], sessions: {}, signups: [], regulars: { 1: ['p6'] }, sessionDate: '2026-07-20',
    monthlyDraw: { month: '2026-07', participants: [], prizes: [], results: [], history: [], spin: null },
    accounts: [], attendance: {}, audit: [],
  };

  // register (public, phone+password)
  let r = await post({ action: 'registerAccount', phone: '0123456789', password: 'secret1', name: 'Kokyan' });
  check('register via dispatcher -> pending', r.status === 200 && r.body.pending === true);

  // GET must not leak accounts/attendance/audit
  const g = await call('GET', {});
  check('GET hides accounts', g.body.accounts === undefined);
  check('GET hides attendance', g.body.attendance === undefined);
  check('GET hides audit', g.body.audit === undefined);

  // list accounts (admin)
  let list = await post({ password: P, action: 'adminListAccounts' });
  check('adminList via dispatcher', list.status === 200 && list.body.accounts.length === 1);
  const id = list.body.accounts[0].id;

  // approve + link
  r = await post({ password: P, action: 'adminApproveAccount', id, playerId: 'p6' });
  check('approve via dispatcher -> active', r.status === 200 && r.body.account.status === 'active');

  // login by phone (public)
  r = await post({ action: 'loginAccount', phone: '+60123456789', password: 'secret1' });
  check('login via dispatcher -> token', r.status === 200 && r.body.ok && typeof r.body.token === 'string');

  // REVEAL — the bug case: confirmPassword must survive the `{password,...updates}` strip.
  r = await post({ password: P, action: 'adminRevealPassword', id, confirmPassword: P });
  check('reveal via dispatcher -> plaintext (confirmPassword survives strip)', r.status === 200 && r.body.password === 'secret1');
  r = await post({ password: P, action: 'adminRevealPassword', id, confirmPassword: 'WRONG' });
  check('reveal wrong confirm -> 401', r.status === 401);

  // CREATE — newPassword must survive the strip (not collide with admin auth).
  r = await post({ password: P, action: 'adminCreateAccount', phone: '0129999999', name: 'Thomas', playerId: 'p0', newPassword: 'brandnew1' });
  check('adminCreate via dispatcher -> active', r.status === 200 && r.body.account.status === 'active');
  r = await post({ action: 'loginAccount', phone: '0129999999', password: 'brandnew1' });
  check('created account can log in with newPassword', r.status === 200 && r.body.ok === true);

  // adminGetOps returns private data to the admin
  r = await post({ password: P, action: 'adminGetOps' });
  check('adminGetOps returns attendance/audit', r.status === 200 && r.body.ok && typeof r.body.attendance === 'object' && Array.isArray(r.body.audit));

  // attendance through the dispatcher; the public GET must not expose it (nor the retired weeklyDraws)
  await post({ password: P, action: 'seedAttendance', date: '2026-07-20' });
  await post({ password: P, action: 'setAttendance', date: '2026-07-20', playerId: 'p6', present: true, paid: true });
  const g2 = await call('GET', {});
  check('public GET hides attendance and has no weeklyDraws', g2.body.attendance === undefined && g2.body.weeklyDraws === undefined && g2.body.weeklySettings === undefined);
  check('retired weeklyDraw action is rejected by the dispatcher', (await post({ password: P, action: 'weeklyDraw', date: '2026-07-20' })).status === 400);

  // ── login codes through the dispatcher (2026-09) ──
  STORE.roster.push({ id: 'p9', name: 'Ah Sheng', photo: null, points: 90 });
  r = await post({ password: P, action: 'adminAssignCodes' });
  check('adminAssignCodes via dispatcher: codes for the players without one, existing accounts reused', r.status === 200 && r.body.ok && r.body.created === 1 && r.body.assigned === 3 && STORE.accounts.length === 3);
  const kokyan = STORE.accounts.find(a => a.playerId === 'p6');
  const ahsheng = STORE.accounts.find(a => a.playerId === 'p9');
  check('phone account (Kokyan) kept its phone + password and gained a code', kokyan.phone === '60123456789' && kokyan.pwHash && /^Kokyan#\d{3}$/.test(kokyan.code));
  check('code-only account (Ah Sheng) is active with no phone', ahsheng.status === 'active' && ahsheng.phone === '' && /^AhSheng#\d{3}$/.test(ahsheng.code));
  check('adminAssignCodes is idempotent via dispatcher', (await post({ password: P, action: 'adminAssignCodes' })).body.assigned === 0);
  check('adminAssignCodes needs the admin password', (await post({ action: 'adminAssignCodes' })).status === 401);
  const g3 = await call('GET', {});
  check('public GET still hides accounts (and so every code)', g3.body.accounts === undefined && !JSON.stringify(g3.body).includes(ahsheng.code));
  const ping = await post({ password: P });
  check('admin auth ping hides accounts too (codes come via adminListAccounts only)', ping.body.state.accounts === undefined);

  // login by code (public, lenient formatting)
  r = await post({ action: 'loginCode', code: ' ah sheng ' + ahsheng.code.split('#')[1] + ' ' });
  check('loginCode via dispatcher -> token (spaces + case ignored)', r.status === 200 && r.body.ok && typeof r.body.token === 'string' && r.body.account.code === ahsheng.code && r.body.account.hasPassword === false);
  const codeToken = r.body.token;
  const wrongDigits = ahsheng.code.endsWith('#000') ? 'AhSheng#001' : 'AhSheng#000';
  check('loginCode wrong digits -> 401', (await post({ action: 'loginCode', code: wrongDigits })).status === 401);
  check('loginCode as a phone account: same session token as password login', (await post({ action: 'loginCode', code: kokyan.code })).body.token === (await post({ action: 'loginAccount', phone: '0123456789', password: 'secret1' })).body.token);

  // memberInfo: own points, owing, wins (draw hash seeded), never anyone else
  HASHES.set('court-draws', new Map([['2026-07-20', JSON.stringify({ date: '2026-07-20', drawnAt: 1700000000000, winners: ['p9', 'p6'], names: { p9: 'Ah Sheng', p6: 'Kokyan' } })]]));
  await post({ password: P, action: 'setAttendance', date: '2026-07-20', playerId: 'p9', present: true, paid: false });
  STORE.attendance['2026-07-20'].entries.p9.payment = { fee: 25, tier: '3h', method: null, paidAt: null };
  r = await post({ action: 'memberInfo', token: codeToken });
  check('memberInfo via dispatcher: 200, own identity', r.status === 200 && r.body.ok && r.body.member.playerId === 'p9' && r.body.member.code === ahsheng.code);
  check('memberInfo: points + threshold progress', r.body.points.points === 90 && r.body.points.threshold === 80 && r.body.points.inDraw === true);
  check('memberInfo: owing from the Payments ledger', r.body.payments.outstanding === 25 && r.body.payments.owing[0].date === '2026-07-20');
  check('memberInfo: session-draw win read from the draws hash', r.body.wins.length === 1 && r.body.wins[0].kind === 'session' && r.body.wins[0].date === '2026-07-20');
  // The expanded win row names the OTHER winners, which GET /api/draws already
  // publishes to anyone. Everything else about another member stays out: no
  // roster ids, and never a row from their ledger.
  check('memberInfo: no other member\'s id or ledger leaks', !JSON.stringify(r.body).includes('p6')
    && !JSON.stringify(r.body.payments).includes('Kokyan') && !JSON.stringify(r.body.points).includes('Kokyan'));
  check('memberInfo: the win detail names co-winners (already public) and nothing more',
    JSON.stringify(r.body.wins[0].detail.others) === JSON.stringify([{ name: 'Kokyan', prize: '' }]));
  check('memberInfo without a valid token -> 401', (await post({ action: 'memberInfo', token: 'nope' })).status === 401 && (await post({ action: 'memberInfo' })).status === 401);
  const snap = JSON.stringify(STORE);
  await post({ action: 'memberInfo', token: codeToken });
  check('memberInfo leaves state untouched', JSON.stringify(STORE) === snap);

  // set / clear one code through the dispatcher
  r = await post({ password: P, action: 'adminSetCode', id: ahsheng.id, code: 'AhSheng#777' });
  check('adminSetCode typed via dispatcher', r.status === 200 && r.body.account.code === 'AhSheng#777');
  check('new code works in any format', (await post({ action: 'loginCode', code: 'ahsheng777' })).status === 200);
  r = await post({ password: P, action: 'adminClearCode', id: ahsheng.id });
  check('adminClearCode via dispatcher', r.status === 200 && r.body.account.code === '' && (await post({ action: 'loginCode', code: 'AhSheng#777' })).status === 401);

  console.log(`\naccounts integration: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
