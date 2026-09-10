#!/usr/bin/env node
/* Pure tests for public/session-draw.js: the fixed schedule table, the paid-before-
 * draw-time eligibility boundary, the seeded (verifiable) shuffle, fewer-than-N and
 * zero-eligible records, list nesting, session candidates and the display shape. */
'use strict';
const S = require('../public/session-draw.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
const SEED = '00112233445566778899aabbccddeeff';
const MYT = 8;

// ── schedule mapping: every weekday ──
// 2026-09-06 Sun, 07 Mon, 08 Tue, 09 Wed, 10 Thu, 11 Fri, 12 Sat
check('Mon -> Fri (+4 days)', S.drawDateFor('2026-09-07') === '2026-09-11');
check('Fri -> Tue (+4 days)', S.drawDateFor('2026-09-11') === '2026-09-15');
check('Sun -> Thu (+4 days)', S.drawDateFor('2026-09-06') === '2026-09-10');
check('Tue never draws', S.drawDateFor('2026-09-08') === null && S.scheduledDrawAt('2026-09-08') === null);
check('Wed never draws', S.drawDateFor('2026-09-09') === null);
check('Thu never draws', S.drawDateFor('2026-09-10') === null);
check('Sat never draws', S.drawDateFor('2026-09-12') === null);
check('isDrawDay agrees with the table', S.isDrawDay('2026-09-07') && S.isDrawDay('2026-09-11') && S.isDrawDay('2026-09-06') && !S.isDrawDay('2026-09-09'));
check('draw time is 09:00 MYT = 01:00 UTC', S.scheduledDrawAt('2026-09-07', MYT) === Date.UTC(2026, 8, 11, 1, 0));
check('offsetHours is honoured', S.scheduledDrawAt('2026-09-07', 0) === Date.UTC(2026, 8, 11, 9, 0));
check('DRAW_TIME constant is 09:00', S.DRAW_TIME === '09:00');
check('table lists exactly Mon/Fri/Sun', Object.keys(S.DRAW_SCHEDULE).sort().join(',') === '0,1,5');
check('month boundary: Fri 2026-10-30 -> Tue 2026-11-03', S.drawDateFor('2026-10-30') === '2026-11-03');
check('year boundary: Sun 2026-12-27 -> Thu 2026-12-31; Mon 2026-12-28 -> Fri 2027-01-01', S.drawDateFor('2026-12-27') === '2026-12-31' && S.drawDateFor('2026-12-28') === '2027-01-01');

// ── eligibility boundary ──
const DATE = '2026-09-07';
const DRAW_AT = S.scheduledDrawAt(DATE, MYT);
const MIN = 60 * 1000;
function entry(id, name, present, paid, paidAt) {
  const e = { playerId: id, name, present, paid, source: 'session' };
  if (paidAt !== undefined) e.payment = { fee: 25, tier: '3h', method: 'cash', paidAt, markedBy: 'admin', feeOverridden: false, createdAt: 1, updatedAt: 1 };
  return e;
}
const day = { date: DATE, entries: {
  p1: entry('p1', 'Alice', true, true, DRAW_AT - MIN),   // one minute before -> eligible
  p2: entry('p2', 'Bob', true, true, DRAW_AT + MIN),     // one minute after -> late
  p3: entry('p3', 'Cara', true, true, DRAW_AT),          // exactly at draw time -> not eligible
  p4: entry('p4', 'Dan', true, false, null),             // unpaid
  p5: entry('p5', 'Eve', false, true, DRAW_AT - MIN),    // absent but paid
  p6: entry('p6', 'Finn', true, true),                   // paid flag without a record (legacy) -> no timestamp
  p7: entry('p7', 'Gus', true, false, null),
} };
const attended = S.attendedFrom(day, []);
check('attended = present entries (6 of 7, Eve absent)', attended.length === 6 && !attended.some((a) => a.id === 'p5'));
check('attended is name-sorted', attended.map((a) => a.name).join(',') === 'Alice,Bob,Cara,Dan,Finn,Gus');
const paid = S.paidFrom(attended, day);
check('paid = attended with paid flag (Alice, Bob, Cara, Finn)', paid.map((p) => p.id).sort().join(',') === 'p1,p2,p3,p6');
check('legacy paid without record has paidAt null', paid.find((p) => p.id === 'p6').paidAt === null);
const eligible = S.eligibleFrom(paid, DRAW_AT);
check('one minute before draw time -> eligible', eligible.some((e) => e.id === 'p1'));
check('one minute after draw time -> NOT eligible', !eligible.some((e) => e.id === 'p2'));
check('exactly at draw time -> NOT eligible (strict <)', !eligible.some((e) => e.id === 'p3'));
check('paid without timestamp -> NOT eligible', !eligible.some((e) => e.id === 'p6'));
check('absent-but-paid -> not even in paid', !paid.some((p) => p.id === 'p5'));
check('eligible has exactly Alice', eligible.length === 1 && eligible[0].name === 'Alice');

// ── attended fallback to the line-up ──
const lineup = [{ id: 'a', name: 'Zed' }, { id: 'b', name: 'Amy' }, { id: 'a', name: 'Zed' }];
const fb = S.attendedFrom({ date: DATE, entries: {} }, lineup);
check('no attendance entries -> line-up is attended (deduped, sorted)', fb.map((a) => a.name).join(',') === 'Amy,Zed');
check('fallback attendees are never paid', S.paidFrom(fb, { entries: {} }).length === 0);
check('null day -> line-up', S.attendedFrom(null, lineup).length === 2);

// ── seeded shuffle ──
const ids = ['p9', 'p1', 'p5', 'p3', 'p7'];
const o1 = S.shuffleWithSeed(ids, SEED), o2 = S.shuffleWithSeed(ids.slice().reverse(), SEED);
check('same seed + same ids -> same order (input order irrelevant)', o1.join() === o2.join());
check('order is a permutation of every id', o1.slice().sort().join() === ids.slice().sort().join());
const o3 = S.shuffleWithSeed(ids, 'ffeeddccbbaa99887766554433221100');
check('different seed -> different order', o3.join() !== o1.join());
check('non-hex seed is hashed and still deterministic', S.shuffleWithSeed(ids, 'hello').join() === S.shuffleWithSeed(ids, 'hello').join());
check('prng output in [0,1)', (() => { const r = S.prngFromSeed(SEED); for (let i = 0; i < 1000; i++) { const v = r(); if (!(v >= 0 && v < 1)) return false; } return true; })());
// Uniformity sanity: over many seeds, each id lands first roughly 1/5 of the time.
(() => {
  const counts = {};
  for (let i = 0; i < 2000; i++) { const f = S.shuffleWithSeed(ids, 'seed-' + i)[0]; counts[f] = (counts[f] || 0) + 1; }
  const vals = Object.values(counts);
  check('first place is spread across all ids (each 12%..28%)', vals.length === 5 && vals.every((v) => v > 240 && v < 560));
})();

// ── full record ──
const bigDay = { date: DATE, entries: {} };
for (let i = 0; i < 20; i++) bigDay.entries['p' + i] = entry('p' + i, 'Player ' + String(i).padStart(2, '0'), true, i < 18, i < 18 ? DRAW_AT - (i + 1) * MIN : null);
const rec = S.buildDrawResult({ date: DATE, drawAt: DRAW_AT, day: bigDay, lineup: [], winnersWanted: 2, seed: SEED, nowMs: DRAW_AT + 5 * MIN, method: 'auto' });
check('20 attended, 18 paid, 18 eligible, 2 winners', rec.counts.attended === 20 && rec.counts.paid === 18 && rec.counts.eligible === 18 && rec.counts.winners === 2);
check('winners are the first two of the recorded order', rec.winners.join() === rec.order.slice(0, 2).join());
check('order is a permutation of eligible', rec.order.slice().sort().join() === rec.eligible.slice().sort().join());
check('lists nest: winners ⊆ eligible ⊆ paid ⊆ attended', rec.winners.every((id) => rec.eligible.includes(id)) && rec.eligible.every((id) => rec.paid.includes(id)) && rec.paid.every((id) => rec.attended.includes(id)));
check('names cover every attendee', rec.attended.every((id) => typeof rec.names[id] === 'string' && rec.names[id]));
check('paidAt recorded for every paid id', rec.paid.every((id) => typeof rec.paidAt[id] === 'number'));
check('record metadata', rec.v === 1 && rec.date === DATE && rec.weekday === 1 && rec.drawAt === DRAW_AT && rec.method === 'auto' && rec.seed === SEED && rec.algorithm === S.ALGORITHM && rec.drawnAt === DRAW_AT + 5 * MIN && rec.shortfall === false && rec.winnersWanted === 2);
check('verifyDrawResult accepts the record', S.verifyDrawResult(rec) === true);
check('verifyDrawResult rejects tampered winners', S.verifyDrawResult(Object.assign({}, rec, { winners: [rec.order[2], rec.order[3]] })) === false);
check('verifyDrawResult rejects tampered order', S.verifyDrawResult(Object.assign({}, rec, { order: rec.order.slice().reverse() })) === false);
check('verifyDrawResult rejects a different seed', S.verifyDrawResult(Object.assign({}, rec, { seed: 'ffeeddccbbaa99887766554433221100' })) === false);
check('verifyDrawResult rejects garbage', S.verifyDrawResult(null) === false && S.verifyDrawResult({}) === false);
check('manual method recorded', S.buildDrawResult({ date: DATE, drawAt: DRAW_AT, day: bigDay, winnersWanted: 2, seed: SEED, nowMs: 1, method: 'manual' }).method === 'manual');
check('unknown method falls back to auto', S.buildDrawResult({ date: DATE, drawAt: DRAW_AT, day: bigDay, winnersWanted: 2, seed: SEED, nowMs: 1, method: 'x' }).method === 'auto');

// ── fewer than N ──
const few = S.buildDrawResult({ date: DATE, drawAt: DRAW_AT, day: day, lineup: [], winnersWanted: 5, seed: SEED, nowMs: 1, method: 'auto' });
check('1 eligible, N=5 -> 1 winner, shortfall recorded', few.winners.length === 1 && few.winners[0] === 'p1' && few.shortfall === true && few.winnersWanted === 5);
const three = { date: DATE, entries: {} };
['x', 'y', 'z'].forEach((id) => { three.entries[id] = entry(id, id.toUpperCase(), true, true, DRAW_AT - MIN); });
const r3 = S.buildDrawResult({ date: DATE, drawAt: DRAW_AT, day: three, winnersWanted: 5, seed: SEED, nowMs: 1 });
check('3 eligible, N=5 -> all 3 drawn, shortfall', r3.winners.length === 3 && r3.shortfall && r3.counts.winners === 3);
check('exactly N eligible -> no shortfall', S.buildDrawResult({ date: DATE, drawAt: DRAW_AT, day: three, winnersWanted: 3, seed: SEED, nowMs: 1 }).shortfall === false);

// ── zero eligible ──
const none = S.buildDrawResult({ date: DATE, drawAt: DRAW_AT, day: { date: DATE, entries: {} }, lineup: lineup, winnersWanted: 2, seed: SEED, nowMs: 1 });
check('zero eligible -> record with no winners but attendees kept', none.winners.length === 0 && none.eligible.length === 0 && none.order.length === 0 && none.attended.length === 2 && none.shortfall === true);
check('zero eligible record still verifies', S.verifyDrawResult(none) === true);

// ── winners setting ──
check('winnersOf defaults to 2 and clamps junk', S.winnersOf(null) === 2 && S.winnersOf({ winners: 'x' }) === 2 && S.winnersOf({ winners: 0 }) === 2 && S.winnersOf({ winners: 11 }) === 2 && S.winnersOf({ winners: 3 }) === 3);
check('isWinnersCount 1..10 integers only', S.isWinnersCount(1) && S.isWinnersCount(10) && !S.isWinnersCount(0) && !S.isWinnersCount(11) && !S.isWinnersCount(2.5) && !S.isWinnersCount('2'));

// ── session candidates ── (DRAW_EPOCH = 2026-09-09; 11 Fri, 13 Sun, 14 Mon, 15 Tue, 16 Wed, 20 Sun, 21 Mon)
const state = {
  sessionDate: '2026-09-14', players: [{ id: 'a', name: 'A' }], sessionDrawAt: 123,
  sessions: {
    '2026-09-11': { players: [{ id: 'a', name: 'A' }], drawAt: 456 },   // Fri, stored drawAt
    '2026-09-15': { players: [{ id: 'a', name: 'A' }] },                // Tue -> never
    '2026-09-16': { players: [] },                                      // Wed, empty
    '2026-09-13': { players: [{ id: 'b', name: 'B' }] },                // Sun, no stored drawAt -> table
    '2026-09-04': { players: [{ id: 'b', name: 'B' }] },                // Fri, before DRAW_EPOCH -> ignored
    '2026-09-20': { players: [] },                                      // Sun, empty snapshot -> ignored
  },
  attendance: { '2026-09-21': { date: '2026-09-21', entries: { z: { playerId: 'z', name: 'Z', present: true, paid: false } } } },
};
const cands = S.sessionCandidates(state, MYT);
check('candidates newest first, only draw days with players/present, on/after epoch',
  cands.map((c) => c.date).join() === '2026-09-21,2026-09-14,2026-09-13,2026-09-11');
check('live day uses stored sessionDrawAt', cands.find((c) => c.date === '2026-09-14').drawAt === 123);
check('snapshot uses stored drawAt', cands.find((c) => c.date === '2026-09-11').drawAt === 456);
check('missing stored drawAt falls back to the table', cands.find((c) => c.date === '2026-09-13').drawAt === S.scheduledDrawAt('2026-09-13', MYT));
check('attendance-only date carries its day record', cands.find((c) => c.date === '2026-09-21').day.entries.z.present === true);
check('live day line-up comes from state.players', cands.find((c) => c.date === '2026-09-14').lineup.length === 1);
check('pre-epoch session is ignored', !cands.some((c) => c.date === '2026-09-04'));
check('DRAW_EPOCH is a valid ISO date', S.isValidISO(S.DRAW_EPOCH));

// ── view shape ──
const results = { '2026-09-07': rec };
const view = S.buildView({ sessionDate: DATE, players: [], sessions: {}, attendance: { [DATE]: bigDay, '2026-09-11': { date: '2026-09-11', entries: { q: entry('q', 'Quinn', true, true, 5) } } } }, results, { nowMs: DRAW_AT + MIN, settings: { winners: 3 }, offsetHours: MYT });
check('view lists result + pending, newest first', view.sessions.map((v) => v.date).join() === '2026-09-11,2026-09-07' && view.hasMore === false);
const done = view.sessions[1], pend = view.sessions[0];
check('done view is frozen to the record', done.status === 'done' && done.counts.winners === 2 && done.lists.winners.length === 2 && done.verified === true && done.seed === SEED && done.method === 'auto');
check('done view names resolve', done.lists.winners.every((w) => /^Player \d\d$/.test(w.name)));
check('done view late flag marks paid-after-cutoff', (() => { const v = S.viewOf({ date: DATE }, S.buildDrawResult({ date: DATE, drawAt: DRAW_AT, day, winnersWanted: 2, seed: SEED, nowMs: 1 }), DRAW_AT, null); const bob = v.lists.paid.find((p) => p.name === 'Bob'); const alice = v.lists.paid.find((p) => p.name === 'Alice'); return bob.late === true && alice.late === false; })());
check('pending view computes live lists and uses the winners setting', pend.status === 'pending' && pend.counts.attended === 1 && pend.counts.eligible === 1 && pend.winnersWanted === 3 && pend.lists.winners.length === 0);
check('pending view due flag', S.viewOf({ date: DATE, drawAt: DRAW_AT, day: null, lineup: [] }, null, DRAW_AT - 1).due === false && S.viewOf({ date: DATE, drawAt: DRAW_AT, day: null, lineup: [] }, null, DRAW_AT).due === true);
check('view paging: limit + before', (() => { const r = S.buildView({ sessions: {}, attendance: {} }, { '2026-09-07': rec, '2026-09-11': Object.assign({}, rec, { date: '2026-09-11' }), '2026-09-14': Object.assign({}, rec, { date: '2026-09-14' }) }, { nowMs: 1, limit: 2 }); const r2 = S.buildView({ sessions: {}, attendance: {} }, { '2026-09-07': rec, '2026-09-11': rec, '2026-09-14': rec }, { nowMs: 1, limit: 2, before: r.nextBefore }); return r.sessions.length === 2 && r.hasMore === true && r.nextBefore === '2026-09-11' && r2.sessions.length === 1 && r2.sessions[0].date === '2026-09-07' && r2.hasMore === false; })());

// ── strings ──
check('statusLabel', S.statusLabel({ status: 'done' }) === 'Drawn' && S.statusLabel({ status: 'pending', due: false }) === 'Pending' && S.statusLabel({ status: 'pending', due: true }) === 'Draw pending');
check('fmtDrawTime renders Malaysia time', S.fmtDrawTime(DRAW_AT) === 'Fri 11 Sep · 9:00 AM');
check('fmtSessionDate', S.fmtSessionDate('2026-09-07') === 'Monday 7 September 2026');
check('drawDayLabel Monday-first', S.drawDayLabel() === 'Mon → Fri, Fri → Tue, Sun → Thu');
check('howItWorksText mentions 3 days, 9:00 AM and the winner count', /within 3 days/.test(S.howItWorksText(2)) && /9:00 AM/.test(S.howItWorksText(2)) && /2 winners are/.test(S.howItWorksText(2)) && /1 winner is/.test(S.howItWorksText(1)));
check('countsLine', S.countsLine({ attended: 20, paid: 18, eligible: 18, winners: 2 }) === '20 attended · 18 paid · 18 eligible · 2 winners');

// ── public projection (no attendance / payment detail on the public page) ──
{
  const day = { entries: { a: { playerId: 'a', name: 'Al', present: true, paid: true, payment: { paidAt: DRAW_AT - 5 } }, b: { playerId: 'b', name: 'Bo', present: true, paid: true, payment: { paidAt: DRAW_AT - 4 } }, c: { playerId: 'c', name: 'Cy', present: true, paid: false } } };
  const r = S.buildDrawResult({ date: '2026-09-07', drawAt: DRAW_AT, day, lineup: [], winnersWanted: 2, seed: SEED, nowMs: DRAW_AT + 1, method: 'auto' });
  const dv = S.viewOf({ date: '2026-09-07' }, r, DRAW_AT + 1000, { winners: 2 });
  const pv = S.publicSessionView(dv);
  check('publicSessionView (done): winners + eligible names only, no attended/paid/paidAt', !pv.lists.attended && !pv.lists.paid && pv.lists.winners.length === 2 && pv.lists.eligible.length === 2 && pv.lists.eligible.concat(pv.lists.winners).every(x => Object.keys(x).join() === 'id,name') && pv.counts.attended === undefined && pv.counts.paid === undefined && pv.counts.eligible === 2 && pv.seed === dv.seed && pv.verified === true && pv.status === 'done');
  const pp = S.publicSessionView(S.viewOf({ date: '2026-09-07', drawAt: DRAW_AT, day, lineup: [] }, null, DRAW_AT - 3600000, { winners: 2 }));
  check('publicSessionView (pending): counts only, no names at all', pp.status === 'pending' && pp.lists.eligible.length === 0 && pp.lists.winners.length === 0 && pp.counts.eligible === 2 && !pp.lists.paid && !pp.lists.attended && pp.winnersWanted === 2);
  check('publicSessionView tolerates junk', S.publicSessionView(null) === null);
}

// ── admin test draw (dry run) ──
{
  const now = DRAW_AT + 5 * 3600 * 1000;
  const day = { entries: { a: { playerId: 'a', name: 'Alice', present: true, paid: true, payment: { paidAt: now - 1000 } }, b: { playerId: 'b', name: 'Bob', present: true, paid: false } } };
  const t = S.testDrawResult({ date: '2026-09-10', day, lineup: [], winnersWanted: 2, seed: SEED, nowMs: now });
  check('testDrawResult: real eligibility when someone has paid (drawAt = now)', t.assumedPaid === false && t.rec.test === true && t.rec.eligible.join() === 'a' && t.rec.winners.join() === 'a' && t.rec.drawAt === now && t.rec.counts.attended === 2 && t.rec.shortfall === true);
  const t2 = S.testDrawResult({ date: '2026-09-10', day: null, lineup: [{ id: 'x', name: 'Xu' }, { id: 'y', name: 'Yi' }, { id: 'z', name: 'Zed' }], winnersWanted: 2, seed: SEED, nowMs: now });
  check('testDrawResult: nobody paid → every attendee treated as paid, flagged, verifiable', t2.assumedPaid === true && t2.rec.counts.eligible === 3 && t2.rec.winners.length === 2 && t2.rec.test === true && S.verifyDrawResult(t2.rec));
  const tv = S.viewOf({ date: '2026-09-10' }, t2.rec, now, { winners: 2 });
  check('viewOf carries test:true and statusLabel says Test draw', tv.test === true && tv.status === 'done' && S.statusLabel(tv) === 'Test draw' && S.statusLabel({ status: 'done' }) === 'Drawn' && S.viewOf({ date: '2026-09-07' }, S.buildDrawResult({ date: '2026-09-07', drawAt: now, seed: SEED, nowMs: now, day: null, lineup: [] }), now, {}).test === false);
  check('testDrawResult: empty input → no winners, no crash', S.testDrawResult({ date: '2026-09-10', day: null, lineup: [], winnersWanted: 2, seed: SEED, nowMs: now }).rec.counts.attended === 0);
}

console.log(`\nsession draw (pure): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
