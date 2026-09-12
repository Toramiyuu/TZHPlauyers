#!/usr/bin/env node
/* Server-side tests for the points-based Monthly Lucky Draw (lib/monthly-lucky.js
 * + its wiring in api/state.js, api/draws.js, api/cron-session-draw.js,
 * api/cron-rollover.js): the in-place month close (points reset + snapshot +
 * audit, migration without a reset), the idempotent automatic sweep (auto on/off,
 * before/after 09:00 on the 1st, racing sweeps), every admin action (settings,
 * prizes incl. photo validation, pull, curation, manual draw refused twice), the
 * public projection served by GET /api/draws, the generic-merge guard, and the
 * crons — all through the in-memory Redis stub. */
'use strict';
process.env.ADMIN_PASSWORD = 'TZH123';
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
  } },
};
process.env.KV_REST_API_URL = 'http://stub';
process.env.KV_REST_API_TOKEN = 'stub';
const handler = require('../api/state.js');
const drawsHandler = require('../api/draws.js');
const cronDrawHandler = require('../api/cron-session-draw.js');
const cronRolloverHandler = require('../api/cron-rollover.js');
const M = require('../lib/monthly-lucky.js');
const ML = require('../public/monthly-lucky.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
const SEED_A = '00112233445566778899aabbccddeeff', SEED_B = 'ffeeddccbbaa99887766554433221100';
const seedA = () => SEED_A, seedB = () => SEED_B;
const SEP_AT = ML.scheduledDrawAt('2026-09', 8); // 1 Oct 2026 09:00 MYT
const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('jpeg-bytes').toString('base64');

function freshState(extra) {
  return Object.assign({
    roster: [{ id: 'p1', name: 'Alice', points: 120 }, { id: 'p2', name: 'Bob', points: 80 }, { id: 'p3', name: 'Cara', points: 40 }, { id: 'p4', name: 'Dan', points: 95 }],
    players: [], sessionDate: '2026-09-28', sessions: {}, attendance: {}, audit: [], signups: [], regulars: {},
    monthlyLucky: { auto: true, winners: 2, threshold: 80, prizes: [{ id: 'pzA', name: 'Racket', qty: 2, desc: 'Yonex Astrox' }, { id: 'pzB', name: 'Socks' }], pointsMonth: '2026-09', pool: null, closed: {} },
  }, extra || {});
}
const opts = (nowMs, extra) => Object.assign({ store: extra && extra.store, nowMs, offsetHours: 8, seedFn: seedA }, extra || {});
const act = (s, body, o) => M.handleMonthlyLuckyAdminAction(s, body, o);

(async () => {
  // ── month close (in place) ──
  let s = freshState();
  check('no close inside the month', M.applyMonthClose(s, '2026-09-30', 1).length === 0 && s.roster[0].points === 120);
  let closed = M.applyMonthClose(s, '2026-10-01', 5);
  check('1 Oct closes September in place: points reset, snapshot kept, audit entry', closed.join() === '2026-09' && s.roster.every(r => r.points === 0) && s.monthlyLucky.pointsMonth === '2026-10'
    && s.monthlyLucky.closed['2026-09'].points.p1 === 120 && s.audit[0].action === 'monthlyLucky.close' && s.audit[0].newValue === 3 && /reached 80/.test(s.audit[0].note));
  check('second call is a no-op', M.applyMonthClose(s, '2026-10-01', 6).length === 0);
  const legacy = { roster: [{ id: 'p1', name: 'Alice', points: 50 }], audit: [] };
  check('legacy blob (no monthlyLucky) is stamped with this month, nobody reset', M.applyMonthClose(legacy, '2026-09-11', 1).length === 0 && legacy.monthlyLucky.pointsMonth === '2026-09' && legacy.roster[0].points === 50);

  // ── sweep ──
  s = freshState(); M.applyMonthClose(s, '2026-10-01', 5);
  let store = M.memoryMonthlyStore();
  let r = await M.sweepMonthlyDraws(s, store, { nowMs: SEP_AT - 1000, offsetHours: 8, seedFn: seedA });
  check('before 09:00 on the 1st: September pending, nothing drawn', r.drawn.length === 0 && r.pending.join() === '2026-09');
  r = await M.sweepMonthlyDraws(s, store, { nowMs: SEP_AT + 1000, offsetHours: 8, seedFn: seedA });
  const sep = await store.get('2026-09');
  check('at 09:00 September is drawn from the closed snapshot', r.drawn.join() === '2026-09' && sep && sep.method === 'auto' && sep.source === 'closed' && sep.eligible.join() === 'p1,p4,p2' && sep.winners.length === 2 && sep.seed === SEED_A && sep.prizes.map(p => p.name).join() === 'Racket,Socks');
  check('record verifies', ML.verifyDrawResult(sep));
  r = await M.sweepMonthlyDraws(s, store, { nowMs: SEP_AT + 5000, offsetHours: 8, seedFn: seedB });
  check('sweep is idempotent (no redraw, seed unchanged)', r.drawn.length === 0 && (await store.get('2026-09')).seed === SEED_A);
  check('the live month is never auto-drawn', !(await store.get('2026-10')) && !r.pending.includes('2026-10'));
  { // racing sweeps → exactly one record
    const s2 = freshState(); M.applyMonthClose(s2, '2026-10-01', 5);
    const st2 = M.memoryMonthlyStore();
    const [a, b] = await Promise.all([M.sweepMonthlyDraws(s2, st2, { nowMs: SEP_AT + 1, offsetHours: 8, seedFn: seedA }), M.sweepMonthlyDraws(s2, st2, { nowMs: SEP_AT + 1, offsetHours: 8, seedFn: seedB })]);
    check('racing sweeps write one record', a.drawn.length + b.drawn.length === 1 && st2.size() === 1);
  }
  { // auto off → waits for the admin
    const s3 = freshState({ monthlyLucky: Object.assign(freshState().monthlyLucky, { auto: false }) }); M.applyMonthClose(s3, '2026-10-01', 5);
    const st3 = M.memoryMonthlyStore();
    const r3 = await M.sweepMonthlyDraws(s3, st3, { nowMs: SEP_AT + 1000, offsetHours: 8, seedFn: seedA });
    check('auto off: closed month stays pending', r3.drawn.length === 0 && r3.pending.join() === '2026-09' && st3.size() === 0);
    const v3 = await M.buildMonthlyView(s3, st3, { nowMs: SEP_AT + 1000, offsetHours: 8 });
    check('view marks it due + waiting for admin, eligible from the snapshot', v3.months[1].status === 'pending' && v3.months[1].due === true && ML.statusLabel(v3.months[1]) === 'Waiting for admin' && v3.months[1].counts.eligible === 3);
    const rr = await act(s3, { action: 'runMonthlyDraw', month: '2026-09' }, opts(SEP_AT + 2000, { store: st3 }));
    check('admin runs the closed month manually', rr.status === 200 && rr.changed && rr.body.result.method === 'manual' && rr.body.result.source === 'closed' && rr.body.result.counts.eligible === 3 && s3.audit[0].action === 'monthlyLucky.draw');
  }
  { // zero eligible → record with no winners
    const s4 = freshState({ roster: [{ id: 'p1', name: 'Alice', points: 10 }] }); M.applyMonthClose(s4, '2026-10-01', 5);
    const st4 = M.memoryMonthlyStore();
    await M.sweepMonthlyDraws(s4, st4, { nowMs: SEP_AT + 1, offsetHours: 8, seedFn: seedA });
    const rec4 = await st4.get('2026-09');
    check('nobody at the threshold: auto record with no winners + shortfall', rec4 && rec4.winners.length === 0 && rec4.shortfall === true && rec4.counts.eligible === 0);
  }

  // ── settings ──
  s = freshState(); store = M.memoryMonthlyStore();
  for (const bad of [{ winners: 0 }, { winners: 21 }, { winners: 'x' }, { threshold: 0 }, { threshold: 10001 }, { threshold: 2.5 }]) {
    r = await act(s, Object.assign({ action: 'setMonthlySettings' }, bad), opts(1, { store }));
    check('setMonthlySettings rejects ' + JSON.stringify(bad), r.status === 400 && s.monthlyLucky.winners === 2 && s.monthlyLucky.threshold === 80);
  }
  r = await act(s, { action: 'setMonthlySettings', auto: false, winners: 3, threshold: '100' }, opts(1, { store }));
  check('setMonthlySettings applies all three + audits each', r.status === 200 && r.changed && r.body.settings.auto === false && r.body.settings.winners === 3 && r.body.settings.threshold === 100 && s.audit.filter(a => a.action === 'monthlyLucky.settings').length === 3);
  r = await act(s, { action: 'setMonthlySettings', winners: 3 }, opts(1, { store }));
  check('same value again -> unchanged', r.status === 200 && r.body.unchanged === true && r.changed === false);
  check('settings change kept pointsMonth / prizes intact', s.monthlyLucky.pointsMonth === '2026-09' && s.monthlyLucky.prizes.length === 2);

  // ── prizes ──
  s = freshState(); store = M.memoryMonthlyStore();
  check('setMonthlyPrizes rejects non-list / empty name / huge / bad photo', (await act(s, { action: 'setMonthlyPrizes', prizes: 'x' }, opts(1, { store }))).status === 400
    && (await act(s, { action: 'setMonthlyPrizes', prizes: [{ name: ' ' }] }, opts(1, { store }))).status === 400
    && (await act(s, { action: 'setMonthlyPrizes', prizes: [{ name: 'x'.repeat(61) }] }, opts(1, { store }))).status === 400
    && (await act(s, { action: 'setMonthlyPrizes', prizes: [{ name: 'Ok', photo: 'data:image/gif;base64,AAAA' }] }, opts(1, { store }))).status === 400
    && (await act(s, { action: 'setMonthlyPrizes', prizes: Array.from({ length: 13 }, (_, i) => ({ name: 'P' + i })) }, opts(1, { store }))).status === 400
    && s.monthlyLucky.prizes.length === 2);
  r = await act(s, { action: 'setMonthlyPrizes', prizes: [{ id: 'pzB', name: 'Socks', photo: PHOTO }, { name: 'New racket', photo: '' }] }, opts(2, { store }));
  check('setMonthlyPrizes stores the ordered list with photos, ids kept/assigned, audit names only', r.status === 200 && r.changed && r.body.prizes.length === 2 && r.body.prizes[0].id === 'pzB' && r.body.prizes[0].photo === PHOTO && r.body.prizes[1].photo === null && r.body.prizes[1].id
    && s.audit[0].action === 'monthlyLucky.prizes' && s.audit[0].prevValue.join() === '2 × Racket,Socks' && s.audit[0].newValue.join() === 'Socks,New racket' && JSON.stringify(s.audit[0]).indexOf('base64') === -1);

  // ── prize quantity + description ──
  check('setMonthlyPrizes rejects qty 0 / 1.5 / 100 and an over-long or non-string description', (await act(s, { action: 'setMonthlyPrizes', prizes: [{ name: 'Ok', qty: 0 }] }, opts(3, { store }))).status === 400
    && (await act(s, { action: 'setMonthlyPrizes', prizes: [{ name: 'Ok', qty: 1.5 }] }, opts(3, { store }))).status === 400
    && (await act(s, { action: 'setMonthlyPrizes', prizes: [{ name: 'Ok', qty: 100 }] }, opts(3, { store }))).status === 400
    && (await act(s, { action: 'setMonthlyPrizes', prizes: [{ name: 'Ok', desc: 'x'.repeat(201) }] }, opts(3, { store }))).status === 400
    && (await act(s, { action: 'setMonthlyPrizes', prizes: [{ name: 'Ok', desc: { a: 1 } }] }, opts(3, { store }))).status === 400
    && s.monthlyLucky.prizes.map(p => p.name).join() === 'Socks,New racket');
  r = await act(s, { action: 'setMonthlyPrizes', prizes: [{ id: 'pzB', name: 'Tube of shuttlecocks', qty: '2', desc: '  Yonex AS-50, 12 pcs  ', photo: PHOTO }, { name: 'Bag', qty: '', desc: null }] }, opts(4, { store }));
  check('setMonthlyPrizes stores qty (blank = 1) + trimmed desc; audit reads "2 × name"', r.status === 200 && r.body.prizes[0].qty === 2 && r.body.prizes[0].desc === 'Yonex AS-50, 12 pcs' && r.body.prizes[0].photo === PHOTO && r.body.prizes[1].qty === 1 && r.body.prizes[1].desc === ''
    && s.monthlyLucky.prizes[0].qty === 2 && s.monthlyLucky.prizes[0].desc === 'Yonex AS-50, 12 pcs' && s.audit[0].newValue.join() === '2 × Tube of shuttlecocks,Bag' && s.audit[0].prevValue.join() === 'Socks,New racket');

  // ── pool + curation + manual draw of the live month ──
  s = freshState(); store = M.memoryMonthlyStore();
  r = await act(s, { action: 'setMonthlyPoolRemoved', playerId: 'p1', removed: true }, opts(1, { store }));
  check('curation before a pull is refused', r.status === 400);
  r = await act(s, { action: 'pullMonthlyPool' }, opts(10, { store }));
  check('pullMonthlyPool = roster at 80+, best first, stamped', r.status === 200 && r.changed && r.body.pool.month === '2026-09' && r.body.pool.pulledAt === 10 && r.body.pool.players.map(p => p.id).join() === 'p1,p4,p2' && s.audit[0].action === 'monthlyLucky.pool');
  r = await act(s, { action: 'setMonthlyPoolRemoved', playerId: 'p4', removed: true }, opts(11, { store }));
  check('remove a player from the pool', r.status === 200 && r.body.pool.removed.join() === 'p4');
  r = await act(s, { action: 'setMonthlyPoolRemoved', playerId: 'p4', removed: false }, opts(12, { store }));
  r = await act(s, { action: 'setMonthlyPoolRemoved', playerId: 'p2', removed: true }, opts(13, { store }));
  check('put back + remove another', r.body.pool.removed.join() === 'p2');
  s.roster[2].points = 90; // Cara crosses the line after the pull
  r = await act(s, { action: 'pullMonthlyPool' }, opts(20, { store }));
  check('pull again picks up the newcomer and keeps the removal', r.body.pool.players.map(p => p.id).join() === 'p1,p4,p3,p2' && r.body.pool.removed.join() === 'p2');
  r = await act(s, { action: 'runMonthlyDraw', month: 'nope' }, opts(30, { store }));
  check('runMonthlyDraw rejects a bad month', r.status === 400);
  r = await act(s, { action: 'runMonthlyDraw', month: '2025-01' }, opts(30, { store }));
  check('runMonthlyDraw 404s an unknown month', r.status === 404);
  r = await act(s, { action: 'runMonthlyDraw', month: '2026-09' }, opts(30, { store }));
  check('manual draw of the live month uses the pool minus removals', r.status === 200 && r.changed && r.body.result.method === 'manual' && r.body.result.source === 'live' && r.body.result.eligible.join() === 'p1,p4,p3' && r.body.result.winners.length === 2 && r.body.result.drawAt === SEP_AT);
  check('audit lists the winners with their prizes', s.audit[0].action === 'monthlyLucky.draw' && s.audit[0].newValue.length === 2 && /—/.test(s.audit[0].newValue[0]));
  check('the record snapshots qty + desc and the audit shows the quantity', r.body.result.prizes[0].qty === 2 && r.body.result.prizes[0].desc === 'Yonex Astrox' && r.body.result.prizes[1].qty === 1 && / — 2 × Racket$/.test(s.audit[0].newValue[0]) && ML.awardsOf(r.body.result)[0].prize === '2 × Racket');
  r = await act(s, { action: 'runMonthlyDraw', month: '2026-09' }, opts(31, { store: Object.assign(store, {}), seedFn: seedB }));
  check('second manual draw -> 409 with the existing result', r.status === 409 && r.body.result.seed === SEED_A);
  M.applyMonthClose(s, '2026-10-01', 40);
  r = await M.sweepMonthlyDraws(s, store, { nowMs: SEP_AT + 1000, offsetHours: 8, seedFn: seedB });
  check('after the month closes the automatic sweep leaves the manual result alone', r.drawn.length === 0 && (await store.get('2026-09')).seed === SEED_A);
  { // manual draw without a pull pulls automatically; nobody eligible -> 400
    const s5 = freshState(); const st5 = M.memoryMonthlyStore();
    const r5 = await act(s5, { action: 'runMonthlyDraw', month: '2026-09' }, opts(50, { store: st5 }));
    check('manual draw with no pull auto-pulls first', r5.status === 200 && s5.monthlyLucky.pool && s5.monthlyLucky.pool.pulledAt === 50 && r5.body.result.eligible.length === 3);
    const s6 = freshState({ roster: [{ id: 'p1', name: 'Al', points: 5 }] }); const st6 = M.memoryMonthlyStore();
    const r6 = await act(s6, { action: 'runMonthlyDraw', month: '2026-09' }, opts(50, { store: st6 }));
    check('manual draw with nobody at the threshold is refused', r6.status === 400 && /Nobody has reached 80 points yet/.test(r6.body.error) && st6.size() === 0);
  }

  // ── getMonthlyDraws (admin view; closes a due month first) ──
  s = freshState(); store = M.memoryMonthlyStore();
  r = await act(s, { action: 'getMonthlyDraws' }, opts(Date.UTC(2026, 9, 1, 2, 0), { store, today: '2026-10-01' }));
  check('getMonthlyDraws closes September, sweeps it, returns settings + months + pool', r.status === 200 && r.changed && r.body.closedMonths.join() === '2026-09' && r.body.pointsMonth === '2026-10'
    && r.body.months.map(m => m.month + ':' + m.status).join() === '2026-10:pending,2026-09:done' && r.body.settings.threshold === 80 && r.body.pool === null && s.roster.every(x => x.points === 0));
  check('unknown action -> 400', (await act(s, { action: 'nope' }, opts(1, { store }))).status === 400);
  check('missing store -> 500', (await M.handleMonthlyLuckyAdminAction(s, { action: 'getMonthlyDraws' }, {})).status === 500);

  // ── HTTP surfaces through the real handlers (stubbed Redis; real clock) ──
  function call(h, method, query, body, headers) {
    return new Promise((resolve) => {
      const res = { setHeader() {}, _c: 200, status(c) { this._c = c; return this; }, json(o) { resolve({ status: this._c, body: o }); }, end() { resolve({ status: this._c, body: null }); } };
      h({ method, query: query || {}, body: body || {}, headers: headers || {} }, res);
    });
  }
  const nowMonth = ML.monthOfInstant(Date.now(), 8), lastMonth = ML.prevMonthKey(nowMonth);
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  STORE = freshState({ siteCode: 'ABC-123', sessionDate: today, monthlyLucky: {
    auto: true, winners: 2, threshold: 80, prizes: [{ id: 'pzA', name: 'Racket', photo: PHOTO }], pointsMonth: nowMonth, pool: null,
    closed: { [lastMonth]: { month: lastMonth, closedAt: 1, points: { p1: 100, p2: 80, p3: 10 }, names: { p1: 'Alice', p2: 'Bob', p3: 'Cara' } } },
  } });
  HASHES.clear();
  const pw = { password: 'TZH123' };
  r = await call(handler, 'GET', { code: 'ABC-123' });
  check('GET /api/state carries the LIGHT monthly settings: no photo bytes, no snapshots', r.body.monthlyLucky && r.body.monthlyLucky.threshold === 80 && r.body.monthlyLucky.prizes[0].hasPhoto === true && r.body.monthlyLucky.prizes[0].photo === undefined && r.body.monthlyLucky.closed === undefined && r.body.monthlyLucky.pointsMonth === nowMonth);
  r = await call(handler, 'POST', {}, pw);
  check('admin auth ping is light too', r.body.ok && r.body.state.monthlyLucky.prizes[0].photo === undefined && r.body.state.monthlyLucky.closed === undefined);
  r = await call(handler, 'POST', {}, Object.assign({ monthlyLucky: { threshold: 1 } }, pw));
  check('generic merge refuses monthlyLucky', r.status === 400 && STORE.monthlyLucky.threshold === 80);
  r = await call(handler, 'POST', {}, Object.assign({ action: 'setMonthlySettings', threshold: 90 }, pw));
  check('dispatcher routes the action and persists', r.status === 200 && r.body.settings.threshold === 90 && STORE.monthlyLucky.threshold === 90 && STORE.audit[0].action === 'monthlyLucky.settings');
  check('action without the password -> 401', (await call(handler, 'POST', {}, { action: 'setMonthlySettings', threshold: 1 })).status === 401 && STORE.monthlyLucky.threshold === 90);
  r = await call(drawsHandler, 'GET', {});
  check('GET /api/draws locked -> no monthly data', r.body.locked === true && r.body.monthly === undefined);
  r = await call(drawsHandler, 'GET', { code: 'ABC-123' });
  check('GET /api/draws carries the public monthly block with prizes (photos) + months', r.status === 200 && r.body.monthly && r.body.monthly.threshold === 90 && r.body.monthly.prizes[0].photo === PHOTO && r.body.monthly.months.map(m => m.month).join() === nowMonth + ',' + lastMonth);
  const lm = r.body.monthly.months[1];
  check('on-view sweep drew the closed month (auto on, 09:00 long past)', lm.status === 'done' && lm.method === 'auto' && HASHES.get(M.MONTHLY_DRAWS_KEY).has(lastMonth));
  // Threshold is 90 by now: only Alice (100) qualifies in the closed month; live month = Alice + Dan.
  check('public projection: winners with prizes, eligible names once drawn, never points', lm.lists.winners.length === 1 && lm.lists.winners[0].prize === 'Racket' && lm.shortfall === true && lm.lists.eligible.length === 1 && lm.lists.eligible.every(e => e.points === undefined) && r.body.monthly.months[0].lists.eligible.length === 0 && r.body.monthly.months[0].counts.eligible === 2);
  check('the public sweep never wrote the state blob', STORE.monthlyLucky.pointsMonth === nowMonth && STORE.roster[0].points === 120);
  r = await call(handler, 'POST', {}, Object.assign({ action: 'getMonthlyDraws' }, pw));
  check('admin getMonthlyDraws: full view with points + prize photos, no re-draw', r.status === 200 && r.body.months[1].status === 'done' && r.body.months[1].lists.eligible[0].points === 100 && r.body.months[1].prizes[0].photo === PHOTO && r.body.closedMonths.length === 0);
  r = await call(handler, 'POST', {}, Object.assign({ action: 'runMonthlyDraw', month: lastMonth }, pw));
  check('manual draw of an already-drawn month -> 409', r.status === 409);
  const stateBefore = JSON.stringify(STORE);
  r = await call(cronDrawHandler, 'GET', {});
  check('09:00 cron runs both sweeps and reports the monthly one', r.status === 200 && r.body.ok === true && r.body.monthly && r.body.monthly.ok === true && r.body.monthly.drawn.length === 0);
  check('cron with nothing to close leaves the blob untouched', JSON.stringify(STORE) === stateBefore);
  // Rollover cron closes a stale points month (simulate: pointsMonth = last month).
  STORE.monthlyLucky.pointsMonth = lastMonth;
  r = await call(cronRolloverHandler, 'GET', {});
  check('00:00 rollover cron closes the old month: points reset + snapshot + audit', r.status === 200 && r.body.ok && r.body.changed === true && r.body.closedMonths.join() === lastMonth && STORE.roster.every(x => x.points === 0) && STORE.monthlyLucky.pointsMonth === nowMonth && STORE.monthlyLucky.closed[lastMonth].points.p1 === 120 && STORE.audit[0].action === 'monthlyLucky.close');
  r = await call(cronRolloverHandler, 'GET', {});
  check('rollover cron is idempotent afterwards', r.body.ok && r.body.changed === false);

  console.log('monthly lucky (handler + http): ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
