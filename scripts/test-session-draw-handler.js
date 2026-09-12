#!/usr/bin/env node
/* Server-side tests for the automatic session draw: the in-memory + Redis-hash
 * stores (putIfAbsent), the idempotent sweep (run twice = one record; racing
 * sweeps = one record), the admin actions (runDraw refused before the scheduled
 * time / after a result exists; winners setting), the snapshot draw-time stamp,
 * and the real HTTP surfaces (api/state.js dispatcher, api/draws.js page endpoint,
 * api/cron-session-draw.js) through the in-memory Redis stub. */
'use strict';
process.env.ADMIN_PASSWORD = 'TZH123';
process.env.DRAW_EPOCH = '2026-09-01'; // fixed fixtures below pre-date the real epoch
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
const cronHandler = require('../api/cron-session-draw.js');
const D = require('../lib/session-draw.js');
const SD = require('../public/session-draw.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
const MIN = 60 * 1000;
const SEED_A = '00112233445566778899aabbccddeeff', SEED_B = 'ffeeddccbbaa99887766554433221100';
const seedA = () => SEED_A, seedB = () => SEED_B;

// Fixtures: Mon 2026-09-07 (draw Fri 11 Sep 09:00 MYT) with 5 attendance records;
// Fri 2026-09-04 (draw Tue 8 Sep) with a line-up but NO attendance (zero eligible);
// live day Mon 2026-09-14 (draw Fri 18 Sep) with players.
const MON = '2026-09-07', FRI = '2026-09-04', LIVE = '2026-09-14';
const MON_AT = SD.scheduledDrawAt(MON, 8), FRI_AT = SD.scheduledDrawAt(FRI, 8);
function entry(id, name, present, paid, paidAt) {
  const e = { playerId: id, name, present, paid, source: 'session' };
  if (paidAt !== undefined) e.payment = { fee: 25, tier: '3h', method: 'cash', paidAt, markedBy: 'admin', feeOverridden: false, createdAt: 1, updatedAt: 1 };
  return e;
}
function freshState() {
  return {
    roster: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }, { id: 'p3', name: 'Cara' }, { id: 'p4', name: 'Dan' }, { id: 'p5', name: 'Eve' }],
    players: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }], sessionDate: LIVE, sessionDrawAt: SD.scheduledDrawAt(LIVE, 8),
    sessions: {
      [MON]: { players: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }, { id: 'p3', name: 'Cara' }, { id: 'p4', name: 'Dan' }, { id: 'p5', name: 'Eve' }], drawAt: MON_AT },
      [FRI]: { players: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }] },
      '2026-09-08': { players: [{ id: 'p1', name: 'Alice' }] }, // Tue: never draws
    },
    attendance: { [MON]: { date: MON, weekday: 1, updatedAt: 0, entries: {
      p1: entry('p1', 'Alice', true, true, MON_AT - MIN), p2: entry('p2', 'Bob', true, true, MON_AT - 2 * MIN), p3: entry('p3', 'Cara', true, true, MON_AT - 3 * MIN),
      p4: entry('p4', 'Dan', true, true, MON_AT + MIN), p5: entry('p5', 'Eve', true, false, null),
    } } },
    drawSettings: { winners: 2 }, audit: [], monthlyDraw: { month: '2026-09', participants: [] }, signups: [], regulars: {},
  };
}

(async () => {
  // ── memory store contract ──
  const st = D.memoryDrawStore();
  check('putIfAbsent writes once', (await st.putIfAbsent('d', { a: 1 })) === true && (await st.putIfAbsent('d', { a: 2 })) === false);
  check('get returns the FIRST record (never overwritten)', (await st.get('d')).a === 1 && (await st.getAll()).d.a === 1 && (await st.get('x')) === null);

  // ── sweep: not yet due ──
  let s = freshState(), store = D.memoryDrawStore();
  let r = await D.sweepSessionDraws(s, store, { nowMs: MON_AT - 1000, offsetHours: 8, seedFn: seedA });
  check('before Monday\'s draw time only the older Friday (already due) is drawn', r.drawn.join() === FRI && r.pending.sort().join() === [MON, LIVE].sort().join());
  const friRec = await store.get(FRI);
  check('zero-eligible session still gets a record with no winners', friRec && friRec.winners.length === 0 && friRec.eligible.length === 0 && friRec.attended.length === 2 && friRec.method === 'auto' && friRec.shortfall === true);
  check('Friday drawAt fell back to the table (snapshot had none)', friRec.drawAt === FRI_AT);

  // ── sweep: due ──
  r = await D.sweepSessionDraws(s, store, { nowMs: MON_AT + 1000, offsetHours: 8, seedFn: seedA });
  check('at draw time Monday is drawn (Friday not redrawn)', r.drawn.join() === MON);
  const monRec = await store.get(MON);
  check('Monday: 5 attended, 4 paid, 3 eligible, 2 winners', monRec.counts.attended === 5 && monRec.counts.paid === 4 && monRec.counts.eligible === 3 && monRec.counts.winners === 2);
  check('Dan paid after the cutoff is paid but not eligible', monRec.paid.includes('p4') && !monRec.eligible.includes('p4'));
  check('winners ⊆ eligible and match the seeded order', monRec.winners.every((id) => monRec.eligible.includes(id)) && monRec.winners.join() === SD.shuffleWithSeed(monRec.eligible, SEED_A).slice(0, 2).join() && SD.verifyDrawResult(monRec));
  check('stored drawAt is the snapshot\'s stamp; drawnAt is the sweep time', monRec.drawAt === MON_AT && monRec.drawnAt === MON_AT + 1000);
  check('sweep never writes state', s.audit.length === 0);

  // ── idempotent ──
  const before = JSON.stringify(await store.getAll());
  r = await D.sweepSessionDraws(s, store, { nowMs: MON_AT + 5 * MIN, offsetHours: 8, seedFn: seedB });
  check('second run draws nothing', r.drawn.length === 0);
  check('store is byte-identical after the second run', JSON.stringify(await store.getAll()) === before);
  check('results echo the stored records', r.results[MON].seed === SEED_A);

  // ── racing sweeps -> exactly one record ──
  s = freshState(); store = D.memoryDrawStore();
  const [ra, rb] = await Promise.all([
    D.sweepSessionDraws(s, store, { nowMs: MON_AT + 1000, offsetHours: 8, seedFn: seedA }),
    D.sweepSessionDraws(s, store, { nowMs: MON_AT + 1000, offsetHours: 8, seedFn: seedB }),
  ]);
  check('race: each date drawn by exactly one sweep', [...ra.drawn, ...rb.drawn].sort().join() === [FRI, MON].sort().join() && store.size() === 2);
  check('race: the loser sees the winner\'s record', ra.results[MON].seed === rb.results[MON].seed && JSON.stringify(ra.results) === JSON.stringify(rb.results));

  // ── runDraw (manual) ──
  s = freshState(); store = D.memoryDrawStore();
  const opts = (now) => ({ store, nowMs: now, offsetHours: 8, seedFn: seedB });
  r = await D.handleSessionDrawAdminAction(s, { action: 'runDraw', date: MON }, opts(MON_AT - MIN));
  check('runDraw before the scheduled time -> 400 with drawAt', r.status === 400 && r.body.drawAt === MON_AT && r.changed === false && store.size() === 0);
  r = await D.handleSessionDrawAdminAction(s, { action: 'runDraw', date: MON }, opts(MON_AT));
  check('runDraw exactly at the scheduled time -> ok, method manual', r.status === 200 && r.body.ok && r.body.result.method === 'manual' && r.changed === true);
  check('runDraw writes an audit entry', s.audit.length === 1 && s.audit[0].action === 'draw.run' && s.audit[0].target.id === MON && Array.isArray(s.audit[0].newValue) && s.audit[0].newValue.length === 2);
  r = await D.handleSessionDrawAdminAction(s, { action: 'runDraw', date: MON }, opts(MON_AT + MIN));
  check('runDraw again -> 409 with the existing result', r.status === 409 && r.body.result.method === 'manual' && r.changed === false);
  check('runDraw on a non-draw weekday -> 400', (await D.handleSessionDrawAdminAction(s, { action: 'runDraw', date: '2026-09-08' }, opts(MON_AT))).status === 400);
  check('runDraw on a draw day with no session -> 404', (await D.handleSessionDrawAdminAction(s, { action: 'runDraw', date: '2026-09-21' }, opts(MON_AT))).status === 404);
  check('runDraw invalid date -> 400', (await D.handleSessionDrawAdminAction(s, { action: 'runDraw', date: 'x' }, opts(MON_AT))).status === 400);
  check('no store -> 500', (await D.handleSessionDrawAdminAction(s, { action: 'runDraw', date: MON }, { nowMs: MON_AT })).status === 500);
  r = await D.sweepSessionDraws(s, store, { nowMs: MON_AT + 1000, offsetHours: 8, seedFn: seedA });
  check('cron after a manual draw leaves it alone', !r.drawn.includes(MON) && (await store.get(MON)).seed === SEED_B);

  // ── setDrawSettings ──
  s = freshState(); store = D.memoryDrawStore();
  for (const bad of [0, 11, 'x', 2.5, null]) {
    r = await D.handleSessionDrawAdminAction(s, { action: 'setDrawSettings', winners: bad }, opts(1));
    check('setDrawSettings rejects ' + JSON.stringify(bad), r.status === 400 && s.drawSettings.winners === 2);
  }
  r = await D.handleSessionDrawAdminAction(s, { action: 'setDrawSettings', winners: 3 }, opts(1));
  check('setDrawSettings 3 -> ok + audit', r.status === 200 && r.changed && s.drawSettings.winners === 3 && s.audit[0].action === 'draw.settings' && s.audit[0].prevValue === 2 && s.audit[0].newValue === 3);
  r = await D.handleSessionDrawAdminAction(s, { action: 'setDrawSettings', winners: '3' }, opts(1));
  check('same value again -> unchanged', r.status === 200 && r.body.unchanged === true && r.changed === false);
  r = await D.sweepSessionDraws(s, store, { nowMs: MON_AT + 1000, offsetHours: 8, seedFn: seedA });
  const mon3 = await store.get(MON);
  check('next draw uses the new winner count (3 eligible, N=3 -> 3 winners, no shortfall)', mon3.winnersWanted === 3 && mon3.winners.length === 3 && mon3.shortfall === false);

  // ── getDraws (admin list) ──
  r = await D.handleSessionDrawAdminAction(s, { action: 'getDraws' }, opts(MON_AT + 1000));
  check('getDraws lists newest first with winnersPerDraw', r.status === 200 && r.body.winnersPerDraw === 3 && r.body.sessions.map((v) => v.date).join() === [LIVE, MON, FRI].join() && r.changed === false);
  check('getDraws statuses', r.body.sessions[0].status === 'pending' && r.body.sessions[1].status === 'done' && r.body.sessions[2].status === 'done');

  // ── applySessionDateChange stamps the draw time ──
  let t = handler.applySessionDateChange({ sessionDate: MON, players: [{ id: 'p1', name: 'Alice' }], sessions: {}, roster: [] }, '2026-09-08', '2026-09-08');
  check('snapshot gets drawAt from the table', t.ok && t.state.sessions[MON].drawAt === MON_AT);
  check('new live day on a non-draw weekday -> sessionDrawAt null', t.state.sessionDrawAt === null);
  t = handler.applySessionDateChange(t.state, '2026-09-11', '2026-09-11');
  check('new live day on a draw weekday -> sessionDrawAt stamped', t.state.sessionDrawAt === SD.scheduledDrawAt('2026-09-11', 8));
  check('sweep prefers the stored stamp over the table', (() => { const st2 = { sessionDate: '2026-09-11', players: [{ id: 'a', name: 'A' }], sessionDrawAt: 5, sessions: {}, attendance: {} }; return SD.sessionCandidates(st2, 8)[0].drawAt === 5; })());

  // ── HTTP surfaces through the real handlers (stubbed Redis; real clock) ──
  function call(h, method, query, body, headers) {
    return new Promise((resolve) => {
      const res = { setHeader() {}, _c: 200, status(c) { this._c = c; return this; }, json(o) { resolve({ status: this._c, body: o }); }, end() { resolve({ status: this._c, body: null }); } };
      h({ method, query: query || {}, body: body || {}, headers: headers || {} }, res);
    });
  }
  // A draw-day date safely in the future keeps one session pending whatever today is.
  const future = (() => { let d = new Date(Date.now() + 8 * 86400000); for (let i = 0; i < 7; i++) { const iso = d.toISOString().slice(0, 10); if (SD.isDrawDay(iso)) return iso; d = new Date(d.getTime() + 86400000); } })();
  STORE = Object.assign(freshState(), { siteCode: 'ABC-123', sessionDate: future, sessionDrawAt: SD.scheduledDrawAt(future, 8), sessions: {
    [MON]: freshState().sessions[MON], [FRI]: freshState().sessions[FRI], '2026-09-08': freshState().sessions['2026-09-08'],
  } });
  HASHES.clear();
  r = await call(drawsHandler, 'GET', {});
  check('GET /api/draws without the site code -> locked', r.status === 200 && r.body.locked === true && !r.body.sessions);
  check('locked GET did not run the sweep', HASHES.size === 0);
  r = await call(drawsHandler, 'GET', { code: 'ABC-123' });
  check('GET /api/draws with the code -> ok + list', r.status === 200 && r.body.ok && Array.isArray(r.body.sessions) && r.body.winnersPerDraw === 2 && typeof r.body.serverTime === 'number');
  check('page view is newest first and includes the future pending day', r.body.sessions[0].date === future && r.body.sessions[0].status === 'pending' && r.body.sessions.map((v) => v.date).join() === [future, MON, FRI].join());
  check('on-view sweep drew the due sessions', r.body.sessions.find((v) => v.date === FRI).status === 'done' && HASHES.get(D.DRAWS_KEY).has(FRI));
  check('record is stored as JSON text and verifies', SD.verifyDrawResult(JSON.parse(HASHES.get(D.DRAWS_KEY).get(FRI))));
  check('public view: counts + winnersWanted, no names for a pending session', (() => { const s0 = r.body.sessions[0]; return s0.lists && Array.isArray(s0.lists.eligible) && (s0.status !== 'pending' || s0.lists.eligible.length === 0) && typeof s0.counts.eligible === 'number' && s0.winnersWanted === 2; })());
  check('public payload never carries attendance lists or pay times', r.body.sessions.every(s => !s.lists.attended && !s.lists.paid && s.counts.attended === undefined && (s.lists.eligible || []).concat(s.lists.winners || []).every(e => e.paidAt === undefined && e.late === undefined)));
  check('paging: limit=1 -> hasMore + nextBefore', (await call(drawsHandler, 'GET', { code: 'ABC-123', limit: '1' })).body.hasMore === true && (await call(drawsHandler, 'GET', { code: 'ABC-123', limit: '1' })).body.nextBefore === future);
  check('paging: before= excludes newer', (await call(drawsHandler, 'GET', { code: 'ABC-123', before: MON })).body.sessions.map((v) => v.date).join() === FRI);
  check('GET /api/draws POST -> 405', (await call(drawsHandler, 'POST', {}, {})).status === 405);
  const drawnCount = HASHES.get(D.DRAWS_KEY).size;
  r = await call(cronHandler, 'GET', {});
  check('cron endpoint runs the same idempotent sweep (nothing new to draw)', r.status === 200 && r.body.ok === true && r.body.drawn.length === 0 && HASHES.get(D.DRAWS_KEY).size === drawnCount);
  process.env.CRON_SECRET = 's3cret';
  check('cron rejects a bad bearer when CRON_SECRET is set', (await call(cronHandler, 'GET', {}, {}, { authorization: 'Bearer nope' })).status === 401);
  check('cron accepts the right bearer', (await call(cronHandler, 'GET', {}, {}, { authorization: 'Bearer s3cret' })).status === 200);
  delete process.env.CRON_SECRET;

  // dispatcher (api/state.js)
  const P = 'TZH123';
  const post = (b) => call(handler, 'POST', {}, b);
  r = await post({ password: P, action: 'runDraw', date: FRI });
  check('runDraw via dispatcher on an already-drawn session -> 409', r.status === 409 && r.body.result && r.body.result.date === FRI);
  r = await post({ password: P, action: 'runDraw', date: future });
  check('runDraw via dispatcher before the time -> 400', r.status === 400);
  r = await post({ password: P, action: 'setDrawSettings', winners: 3 });
  check('setDrawSettings via dispatcher persists', r.status === 200 && STORE.drawSettings.winners === 3 && STORE.audit[0].action === 'draw.settings');
  check('winners setting is not accepted through the generic merge', (await post({ password: P, drawSettings: { winners: 9 } })).status === 400 && STORE.drawSettings.winners === 3);
  check('sessionDrawAt is not accepted through the generic merge', (await post({ password: P, sessionDrawAt: 1 })).status === 400);
  r = await post({ password: P, action: 'getDraws' });
  check('getDraws via dispatcher', r.status === 200 && r.body.ok && r.body.winnersPerDraw === 3 && r.body.sessions.length === 3);
  check('unauthenticated runDraw -> 401', (await post({ action: 'runDraw', date: FRI })).status === 401);
  r = await post({ password: P, action: 'adminGetOps' });
  check('adminGetOps exposes drawSettings, not the retired weekly keys', r.body.drawSettings.winners === 3 && r.body.weeklyDraws === undefined && r.body.weeklySettings === undefined);
  STORE.weeklyDraws = { '2026-07-20': { eligible: [{ name: 'leak' }] } }; STORE.weeklySettings = { enabled: true };
  r = await call(handler, 'GET', { code: 'ABC-123' });
  check('public GET never exposes weeklyDraws / weeklySettings / attendance', r.body.weeklyDraws === undefined && r.body.weeklySettings === undefined && r.body.attendance === undefined);
  check('public GET carries drawSettings + sessionDrawAt (harmless, public-safe)', r.body.drawSettings.winners === 3 && r.body.sessionDrawAt === SD.scheduledDrawAt(future, 8));
  STORE = { players: [], sessionDate: '2026-09-11', sessions: {} }; // ancient blob, no drawSettings
  r = await call(handler, 'GET', {});
  check('old blob normalises drawSettings + sessionDrawAt', r.body.drawSettings.winners === 2 && r.body.sessionDrawAt === SD.scheduledDrawAt('2026-09-11', 8));

  console.log(`\nsession draw (handler + http): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
