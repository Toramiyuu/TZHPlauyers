#!/usr/bin/env node
/*
 * test-state-lock.js — two writers at once must not lose a write.
 *
 * Every POST to api/state.js is read-modify-write of one Redis blob. Upstash
 * hands each reader its own copy, so two requests that overlap each store a
 * blob missing the other's change. Found in the 2026-11-10 audit: a treasurer
 * ticking payments while the organiser ran courts could lose a payment with no
 * error anywhere. withStateLock (SET NX PX) puts writers in a line.
 *
 * The stub below behaves like Upstash where it matters: a fresh copy per read,
 * a few ms of latency on every call, and SET NX/PX + DEL for the lock.
 * Exit 0 = green.
 */
'use strict';
process.env.ADMIN_PASSWORD = 'TZH123';
let STORE = null;
const LOCKS = new Map();
let lockCalls = 0;
const lag = () => new Promise(r => setTimeout(r, 5 + Math.random() * 25));
const copy = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
require.cache[require.resolve('@upstash/redis')] = {
  id: require.resolve('@upstash/redis'), loaded: true,
  exports: { Redis: class {
    async get(k) { await lag(); return String(k).endsWith(':lock') ? (LOCKS.get(k) || null) : copy(STORE); }
    async set(k, v, opts) {
      await lag();
      if (String(k).endsWith(':lock')) {
        lockCalls++;
        if (opts && opts.nx && LOCKS.has(k)) return null;
        LOCKS.set(k, v);
        if (opts && opts.px) setTimeout(() => { if (LOCKS.get(k) === v) LOCKS.delete(k); }, opts.px).unref();
        return 'OK';
      }
      STORE = copy(v); return 'OK';
    }
    async del(k) { await lag(); LOCKS.delete(k); return 1; }
  } },
};
process.env.KV_REST_API_URL = 'http://stub';
process.env.KV_REST_API_TOKEN = 'stub';
const handler = require('../api/state.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log('  FAIL  ' + name); } };
function call(method, body) {
  return new Promise((resolve) => {
    const res = { setHeader() {}, _c: 200, status(c) { this._c = c; return this; }, json(o) { resolve({ status: this._c, body: o }); }, end() { resolve({ status: this._c, body: null }); } };
    handler({ method, query: {}, headers: {}, body: body || {} }, res);
  });
}
const isoDaysAgo = (n) => new Date(Date.now() + 8 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
const DATE = isoDaysAgo(1);

(async () => {
  const ids = Array.from({ length: 10 }, (_, i) => 'p' + i);
  STORE = {
    roster: ids.map(id => ({ id, name: id.toUpperCase(), photo: null, points: 0 })),
    players: ids.map(id => ({ id, name: id.toUpperCase() })),
    sessions: {}, signups: [], regulars: {}, sessionDate: DATE, rounds: [], numCourts: 2,
    accounts: [], attendance: {}, audit: [],
  };
  let r = await call('POST', { password: 'TZH123', action: 'generatePayments', date: DATE });
  check('payment records created', r.status === 200 && r.body.created === 10);

  // Ten different rows marked paid at the same instant.
  const all = await Promise.all(ids.map(id => call('POST', { password: 'TZH123', action: 'setPayment', date: DATE, playerId: id, paid: true, method: 'cash' })));
  check('every tap answered ok', all.every(x => x.status === 200 && x.body.ok));
  const paid = ids.filter(id => STORE.attendance[DATE].entries[id].paid);
  check(`all 10 payments are stored (got ${paid.length})`, paid.length === 10);
  check('the lock was actually used', lockCalls >= 10);
  check('the lock is released afterwards', LOCKS.size === 0);

  // A generic merge and a named action at the same time both land.
  await Promise.all([
    call('POST', { password: 'TZH123', numCourts: 3 }),
    call('POST', { password: 'TZH123', action: 'setPayment', date: DATE, playerId: 'p0', paid: false }),
  ]);
  check('a court change and a payment change both survive', STORE.numCourts === 3 && STORE.attendance[DATE].entries.p0.paid === false);

  // GETs never wait for a writer.
  LOCKS.set('court-state:lock', 'someone-else');
  const t0 = Date.now();
  const g = await call('GET', {});
  check('a read is not held up by a held lock', g.status === 200 && Date.now() - t0 < 1000);
  LOCKS.clear();

  console.log(`state lock: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
