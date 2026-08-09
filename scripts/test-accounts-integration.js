#!/usr/bin/env node
/* Integration tests through the REAL api/state.js POST dispatcher (with an
 * in-memory Redis stub, like dev-server.js). This exercises the `{password,
 * ...updates}` strip that unit tests bypass — it's what caught the reveal /
 * create-account field-name collision with the admin-auth `password` field. */
'use strict';
const crypto = require('crypto');
process.env.ACCOUNT_ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.ADMIN_PASSWORD = 'TZH123';

// Stub @upstash/redis BEFORE requiring the handler.
let STORE = null;
require.cache[require.resolve('@upstash/redis')] = {
  id: require.resolve('@upstash/redis'), loaded: true,
  exports: { Redis: class { async get() { return STORE; } async set(_k, v) { STORE = v; return 'OK'; } } },
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
    accounts: [], attendance: {}, weeklyDraws: {}, audit: [],
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

  // weekly draw through the dispatcher
  await post({ password: P, action: 'seedAttendance', date: '2026-07-20' });
  await post({ password: P, action: 'setAttendance', date: '2026-07-20', playerId: 'p6', present: true, paid: true });
  r = await post({ password: P, action: 'weeklyDraw', date: '2026-07-20' });
  check('weeklyDraw via dispatcher -> winner', r.status === 200 && r.body.ok && r.body.result.winner.playerId === 'p6');

  // public GET now exposes the winner but NOT the eligible name list
  const g2 = await call('GET', {});
  const wd = g2.body.weeklyDraws['2026-07-20'];
  check('public GET shows winner', wd && wd.winner && wd.winner.name === 'Kokyan');
  check('public GET hides eligible list', wd && wd.eligible === undefined && wd.eligibleCount === 1);

  console.log(`\naccounts integration: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
