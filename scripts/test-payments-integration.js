#!/usr/bin/env node
/* Payments through the REAL api/state.js dispatcher (in-memory Redis stub, like
 * dev-server.js). Guards the admin gate, the `{password, ...updates}` strip (none of
 * our field names may collide), the public-GET privacy projection, feeTier validation
 * on the generic merge, and feeTier snapshot/restore across a session-date change. */
'use strict';
process.env.ADMIN_PASSWORD = 'TZH123';
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
    const res = { setHeader() {}, _c: 200, status(c) { this._c = c; return this; }, json(o) { resolve({ status: this._c, body: o }); }, end() { resolve({ status: this._c, body: null }); } };
    handler({ method, query: query || {}, body: body || {} }, res);
  });
}
const P = 'TZH123';
const post = (b) => call('POST', {}, b);
const DATE = '2026-09-07';

(async () => {
  STORE = {
    roster: [{ id: 'p0', name: 'Thomas', photo: null, points: 0 }, { id: 'p1', name: 'Desmond', photo: null, points: 0 }],
    players: [{ id: 'p0', name: 'Thomas' }, { id: 'p1', name: 'Desmond' }],
    sessions: {}, signups: [], regulars: {}, sessionDate: DATE, rounds: [], numCourts: 2,
    monthlyDraw: { month: '2026-09', participants: [], prizes: [], results: [], history: [], spin: null },
    accounts: [], attendance: {}, audit: [],
    // no feeTier on purpose: an old blob must normalise to the default
  };

  // old blob → feeTier defaults on GET
  let g = await call('GET', {});
  check('GET normalises missing feeTier to 3h', g.body.feeTier === '3h');

  // admin gate
  let r = await post({ action: 'generatePayments', date: DATE });
  check('generatePayments without password → 401', r.status === 401);
  r = await post({ password: 'WRONG', action: 'generatePayments', date: DATE });
  check('generatePayments wrong password → 401', r.status === 401);

  // generate via dispatcher
  r = await post({ password: P, action: 'generatePayments', date: DATE });
  check('generatePayments via dispatcher → created 2', r.status === 200 && r.body.ok && r.body.created === 2 && r.body.existed === 0);
  check('persisted to store', STORE.attendance[DATE].entries.p0.payment.fee === 25);
  r = await post({ password: P, action: 'generatePayments', date: DATE });
  check('second press → 0 created, 2 existed', r.body.created === 0 && r.body.existed === 2);

  // set via dispatcher (fields survive the password strip)
  r = await post({ password: P, action: 'setPayment', date: DATE, playerId: 'p0', paid: true, method: 'cash' });
  check('setPayment via dispatcher → paid with paidAt', r.status === 200 && r.body.ok && r.body.entry.paid === true && typeof r.body.entry.payment.paidAt === 'number' && r.body.entry.payment.method === 'cash');
  r = await post({ password: P, action: 'setPayment', date: DATE, playerId: 'p1', tier: '2h', fee: 18 });
  check('setPayment tier + fee override', r.body.entry.payment.tier === '2h' && r.body.entry.payment.fee === 18 && r.body.entry.payment.feeOverridden === true);
  r = await post({ password: P, action: 'setPayment', date: DATE, playerId: 'p1', method: 'card' });
  check('setPayment bad method → 400', r.status === 400);

  // privacy: public GET never carries attendance (and therefore payments)
  g = await call('GET', {});
  check('public GET hides attendance/payments', g.body.attendance === undefined);
  check('public GET hides audit', g.body.audit === undefined);

  // adminGetOps carries payments + tier
  r = await post({ password: P, action: 'adminGetOps' });
  check('adminGetOps returns payment records + feeTier + sessionDate', r.body.ok && r.body.attendance[DATE].entries.p0.payment.method === 'cash' && r.body.feeTier === '3h' && r.body.sessionDate === DATE);

  // feeTier on the generic merge is validated
  r = await post({ password: P, feeTier: '5h' });
  check('feeTier junk → 400', r.status === 400);
  r = await post({ password: P, feeTier: '2h' });
  check('feeTier 2h → ok', r.status === 200 && r.body.ok === true && STORE.feeTier === '2h');
  g = await call('GET', {});
  check('GET shows feeTier 2h', g.body.feeTier === '2h');

  // session date change snapshots the tier, fresh day resets, revisit restores
  r = await post({ password: P, sessionDate: '2026-09-09' });
  check('date change ok', r.status === 200 && r.body.ok === true);
  check('outgoing day snapshot carries feeTier 2h', STORE.sessions[DATE] && STORE.sessions[DATE].feeTier === '2h');
  check('fresh day resets feeTier to 3h', STORE.feeTier === '3h');
  check('attendance/payments for the old date retained', STORE.attendance[DATE].entries.p0.payment.method === 'cash');
  r = await post({ password: P, sessionDate: DATE });
  check('revisit restores feeTier 2h', STORE.feeTier === '2h' && STORE.sessions[DATE] === undefined);

  // generating for a PAST date uses the snapshot's players + tier
  await post({ password: P, sessionDate: '2026-09-09' });
  await post({ password: P, players: [{ id: 'p1', name: 'Desmond' }] });
  r = await post({ password: P, action: 'generatePayments', date: '2026-09-09' });
  check('generate for live day (1 player)', r.body.created === 1);
  r = await post({ password: P, action: 'generatePayments', date: DATE });
  check('generate for past date → idempotent against its existing records', r.body.created === 0 && r.body.existed === 2);

  // weekly setAttendance through the dispatcher keeps the payment record
  r = await post({ password: P, action: 'setAttendance', date: DATE, playerId: 'p0', paid: false });
  check('setAttendance via dispatcher keeps payment + clears paidAt', r.status === 200 && STORE.attendance[DATE].entries.p0.payment && STORE.attendance[DATE].entries.p0.payment.paidAt === null);

  console.log(`\npayments integration: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
