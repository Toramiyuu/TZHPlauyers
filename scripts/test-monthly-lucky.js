#!/usr/bin/env node
/* Pure-logic tests for the points-based Monthly Lucky Draw (public/monthly-lucky.js):
 * month helpers + schedule, settings/prize normalisation, eligibility from the
 * roster and from a closed snapshot, pool building + staleness, the month close
 * (points reset + snapshot, migration without a reset), the seeded record +
 * verification + prize mapping, candidates, the view shapes (admin vs public)
 * and the copy. Everything injects its clock/seed, so it is deterministic. */
'use strict';
const ML = require('../public/monthly-lucky.js');
const SD = require('../public/session-draw.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
const SEED = '00112233445566778899aabbccddeeff';
const roster = [
  { id: 'p1', name: 'Alice', points: 120 }, { id: 'p2', name: 'Bob', points: 80 }, { id: 'p3', name: 'Cara', points: 79 },
  { id: 'p4', name: 'Dan', points: 95 }, { id: 'p5', name: 'Eve', points: 0 }, { id: 'p6', name: 'Finn' },
];

// ── months ──
check('monthKeyOf / isMonthKey / label', ML.monthKeyOf('2026-09-11') === '2026-09' && ML.isMonthKey('2026-09') && !ML.isMonthKey('2026-13') && !ML.isMonthKey('2026-9') && ML.monthLabel('2026-09') === 'September 2026');
check('next / prev month roll over the year', ML.nextMonthKey('2026-12') === '2027-01' && ML.prevMonthKey('2026-01') === '2025-12' && ML.shiftMonthKey('2026-09', -14) === '2025-07');
check('draw date = 1st of the following month', ML.drawDateFor('2026-09') === '2026-10-01' && ML.drawDateFor('2026-12') === '2027-01-01' && ML.drawDateFor('nope') === null);
check('scheduled draw instant = 09:00 MYT on that day', ML.scheduledDrawAt('2026-09', 8) === Date.UTC(2026, 9, 1, 1, 0) && ML.scheduledDrawAt('x') === null);
check('monthOfInstant / isoOfInstant use Malaysia time', ML.monthOfInstant(Date.UTC(2026, 8, 30, 20, 0), 8) === '2026-10' && ML.isoOfInstant(Date.UTC(2026, 8, 30, 20, 0), 8) === '2026-10-01');
check('yearOf reads the year, and nothing from a non-month', ML.yearOf('2026-09') === 2026 && ML.yearOf('2026-9') === 0 && ML.yearOf(null) === 0);
check('monthYearGrid is Jan..Dec of one year, keyed like every other month', (() => {
  const g = ML.monthYearGrid(2026);
  return g.year === 2026 && g.cells.length === 12
    && g.cells[0].month === '2026-01' && g.cells[0].short === 'Jan' && g.cells[0].long === 'January'
    && g.cells[11].month === '2026-12' && g.cells[11].short === 'Dec'
    && g.cells.every((c) => ML.isMonthKey(c.month));
})());

// ── settings ──
const s0 = ML.settingsOf({});
check('defaults: auto on, 3 winners, 80 points, no prizes', s0.auto === true && s0.winners === 3 && s0.threshold === 80 && s0.prizes.length === 0);
const s1 = ML.settingsOf({ monthlyLucky: { auto: false, winners: 7, threshold: 150, prizes: [{ id: 'aa', name: ' Racket ' }, { name: '' }, { id: 'aa', name: 'Dup id' }, { id: 'bad id!', name: 'Fixed' }] } });
check('settings honour valid values', s1.auto === false && s1.winners === 7 && s1.threshold === 150);
check('prizes: trimmed, empty dropped, duplicate ids made unique, bad ids replaced', s1.prizes.map(p => p.id + ':' + p.name).join(',') === 'aa:Racket,aax:Dup id,pz4:Fixed');
check('junk settings fall back', ML.settingsOf({ monthlyLucky: { winners: 0, threshold: 'x' } }).winners === 3 && ML.settingsOf({ monthlyLucky: { winners: 21 } }).winners === 3 && ML.settingsOf({ monthlyLucky: { threshold: 0 } }).threshold === 80);
check('isPhoto accepts small jpeg/png/webp data URLs only', ML.isPhoto('data:image/jpeg;base64,AAAA') && ML.isPhoto('data:image/png;base64,AAAA') && !ML.isPhoto('data:image/gif;base64,AAAA') && !ML.isPhoto('http://x/y.jpg') && !ML.isPhoto('data:image/jpeg;base64,' + 'A'.repeat(ML.MAX_PHOTO_BYTES)));
check('normalizePrizes caps the list and keeps photos', ML.normalizePrizes(Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, name: 'P' + i, photo: 'data:image/jpeg;base64,QUJD' }))).length === ML.MAX_PRIZES && ML.normalizePrizes([{ id: 'p', name: 'P', photo: 'data:image/jpeg;base64,QUJD' }])[0].photo === 'data:image/jpeg;base64,QUJD');
const n0 = ML.normalize(undefined, '2026-09-11');
check('normalize: missing blob → defaults with pointsMonth = this month', n0.pointsMonth === '2026-09' && n0.pool === null && Object.keys(n0.closed).length === 0);
const lite = ML.liteOf({ prizes: [{ id: 'a', name: 'A', photo: 'data:image/jpeg;base64,QUJD' }], pool: { month: '2026-09', pulledAt: 5, players: [{ id: 'p1', name: 'Alice', points: 90 }], removed: ['p9'] }, closed: { '2026-08': { points: { p1: 1 } } } }, '2026-09-11');
check('liteOf: no photo bytes, no snapshots, pool as a count', lite.prizes[0].hasPhoto === true && lite.prizes[0].photo === undefined && lite.closed === undefined && lite.pool.count === 1 && lite.pool.removed[0] === 'p9');

// ── eligibility ──
const el = ML.eligibleFromRoster(roster, 80);
check('eligible = points >= threshold, best first, name tie-break', el.map(p => p.id).join(',') === 'p1,p4,p2');
check('threshold junk → default 80', ML.eligibleFromRoster(roster, 'x').length === 3 && ML.eligibleFromRoster(roster, 100).length === 1);
const snap = { points: { p1: 100, p2: 50, p3: 80 }, names: { p1: 'Alice', p2: 'Bob' } };
check('eligible from a closed snapshot (name falls back to id)', ML.eligibleFromSnapshot(snap, 80).map(p => p.id + ':' + p.name).join(',') === 'p1:Alice,p3:p3');
check('applyRemoved drops curated ids', ML.applyRemoved(el, ['p4']).map(p => p.id).join(',') === 'p1,p2');

// ── pool ──
const st = { roster, monthlyLucky: { threshold: 80, pointsMonth: '2026-09', pool: { month: '2026-09', pulledAt: 1, players: [{ id: 'p1', name: 'Alice', points: 100 }], removed: ['p4', 'p9'] } } };
const pool = ML.buildPool(st, '2026-09', 999);
check('buildPool: fresh players, keeps removals that still qualify, drops stale ones', pool.pulledAt === 999 && pool.players.map(p => p.id).join(',') === 'p1,p4,p2' && pool.removed.join(',') === 'p4');
check('buildPool for another month starts with no removals', ML.buildPool(st, '2026-10', 1).removed.length === 0);
check('poolStaleIds: who crossed the line since the pull', ML.poolStaleIds(st, st.monthlyLucky.pool).join(',') === 'p4,p2' && ML.poolStaleIds(st, null).length === 0);

// ── month close ──
const noKey = { roster, monthlyLucky: { threshold: 80 } };
const c0 = ML.closeIfDue(noKey, '2026-09-11', 5);
check('close: blob without pointsMonth is stamped, nobody reset', c0.changed && c0.closedMonths.length === 0 && c0.state.monthlyLucky.pointsMonth === '2026-09' && c0.state.roster[0].points === 120);
check('close: same month → no change', ML.closeIfDue(c0.state, '2026-09-30', 6).changed === false && ML.closeDue(c0.state, '2026-09-30') === null);
const c1 = ML.closeIfDue(c0.state, '2026-10-01', 7);
check('close: new month → snapshot + everyone to 0 + pointsMonth advances', c1.changed && c1.closedMonths.join() === '2026-09' && c1.state.monthlyLucky.pointsMonth === '2026-10'
  && c1.state.roster.every(r => r.points === 0) && c1.state.monthlyLucky.closed['2026-09'].points.p1 === 120 && c1.state.monthlyLucky.closed['2026-09'].points.p6 === 0 && c1.state.monthlyLucky.closed['2026-09'].names.p2 === 'Bob' && c1.state.monthlyLucky.closed['2026-09'].closedAt === 7);
check('close is pure (input untouched)', c0.state.roster[0].points === 120 && c0.state.monthlyLucky.pointsMonth === '2026-09');
check('closeDue names the month to close', ML.closeDue(c0.state, '2026-11-02') === '2026-09');
{ // keeps the last 12 closed months only
  const closed = {}; for (let i = 1; i <= 13; i++) closed['2025-' + String(i).padStart(2, '0')] = { points: {} };
  const many = { roster, monthlyLucky: { pointsMonth: '2026-01', closed: { '2025-01': { points: {} }, ...closed } } };
  const cx = ML.closeIfDue(many, '2026-02-01', 1);
  const keys = Object.keys(cx.state.monthlyLucky.closed);
  check('close prunes to the newest 12 snapshots', keys.length === 12 && keys.includes('2026-01') && !keys.includes('2025-01'));
}

// ── record ──
const players = ML.eligibleFromRoster(roster, 80);
const prizes = [{ id: 'x', name: 'Racket' }, { id: 'y', name: 'Socks' }];
const rec = ML.buildDrawResult({ month: '2026-09', drawAt: ML.scheduledDrawAt('2026-09', 8), players, threshold: 80, winnersWanted: 2, prizes, seed: SEED, nowMs: 123, method: 'auto', source: 'closed' });
check('record: shape + counts', rec.kind === 'monthly' && rec.month === '2026-09' && rec.label === 'September 2026' && rec.counts.eligible === 3 && rec.counts.winners === 2 && rec.shortfall === false && rec.method === 'auto' && rec.source === 'closed' && rec.algorithm === SD.ALGORITHM);
check('record: order is the seeded shuffle of the sorted ids; winners = first N', rec.order.join(',') === SD.shuffleWithSeed(['p1', 'p2', 'p4'], SEED).join(',') && rec.winners.join(',') === rec.order.slice(0, 2).join(','));
check('record: names + points + prizes snapshotted (names only)', rec.names.p1 === 'Alice' && rec.points.p4 === 95 && rec.prizes.length === 2 && rec.prizes[0].photo === undefined);
check('verifyDrawResult accepts the record and rejects tampering', ML.verifyDrawResult(rec) && !ML.verifyDrawResult(Object.assign({}, rec, { winners: [rec.order[2], rec.order[0]] })) && !ML.verifyDrawResult(Object.assign({}, rec, { algorithm: 'other' })));
check('awardsOf: winner k gets prize k; extras win with no prize', (() => { const a = ML.awardsOf(Object.assign({}, rec, { winners: rec.order, winnersWanted: 3 })); return a.length === 3 && a[0].prize === 'Racket' && a[1].prize === 'Socks' && a[2].prize === '' && a[2].rank === 3 && a[0].name === rec.names[rec.order[0]]; })());
check('record: more winners wanted than eligible → shortfall', ML.buildDrawResult({ month: '2026-09', players, winnersWanted: 5, seed: SEED, nowMs: 1 }).shortfall === true);
check('record: zero players → no winners, no crash', ML.buildDrawResult({ month: '2026-09', players: [], seed: SEED, nowMs: 1 }).winners.length === 0);
check('same seed + same players = same winners; different seed differs', ML.buildDrawResult({ month: '2026-09', players, winnersWanted: 2, seed: SEED, nowMs: 1 }).winners.join() === rec.winners.join() && ML.buildDrawResult({ month: '2026-09', players, winnersWanted: 2, seed: 'ffeeddccbbaa99887766554433221100', nowMs: 1 }).order.join() !== rec.order.join());

// ── candidates + playersFor ──
const st2 = { roster, monthlyLucky: { threshold: 80, pointsMonth: '2026-10', pool: { month: '2026-09', pulledAt: 1, players: [], removed: ['p1'] }, closed: { '2026-09': { month: '2026-09', points: { p1: 100, p2: 80, p3: 10 }, names: { p1: 'Alice', p2: 'Bob', p3: 'Cara' } } } } };
const cands = ML.monthCandidates(st2, 8);
check('candidates: closed months + the live month, newest first', cands.map(c => c.month + (c.closed ? ':c' : '') + (c.live ? ':l' : '')).join(',') === '2026-10:l,2026-09:c');
check('playersFor closed month = snapshot minus that month\'s removals', ML.playersFor(st2, '2026-09').players.map(p => p.id).join(',') === 'p2' && ML.playersFor(st2, '2026-09').source === 'closed');
check('playersFor live month without a pull = live roster', ML.playersFor(st2, '2026-10').players.map(p => p.id).join(',') === 'p1,p4,p2' && ML.playersFor(st2, '2026-10').source === 'live');
check('playersFor live month with a pull = the pulled pool minus removals', (() => { const s = { roster, monthlyLucky: { threshold: 80, pointsMonth: '2026-10', pool: { month: '2026-10', pulledAt: 1, players: [{ id: 'p1', name: 'Alice', points: 90 }, { id: 'p2', name: 'Bob', points: 80 }], removed: ['p2'] } } }; const r = ML.playersFor(s, '2026-10'); return r.players.map(p => p.id).join() === 'p1'; })());
check('playersFor unknown month = null', ML.playersFor(st2, '2025-01') === null);

// ── views ──
const NOW = Date.UTC(2026, 9, 1, 2, 0); // 10:00 MYT on 1 Oct — September is due
const view = ML.buildView(st2, { '2026-09': rec }, { nowMs: NOW, offsetHours: 8 });
check('buildView: settings + pointsMonth + months newest first', view.settings.threshold === 80 && view.pointsMonth === '2026-10' && view.months.map(m => m.month).join(',') === '2026-10,2026-09');
const done = view.months[1], live = view.months[0];
check('done view: status/verified/lists/prizes', done.status === 'done' && done.verified === true && done.lists.winners.length === 2 && done.lists.winners[0].rank === 1 && done.lists.winners[0].prize === 'Racket' && done.lists.eligible.length === 3 && done.lists.eligible[0].points === 120 && done.prizes[0].name === 'Racket' && done.prizes[0].photo === null);
check('live view: pending, eligible so far from the roster, prizes from settings', live.status === 'pending' && live.live === true && live.counts.eligible === 3 && live.lists.eligible[0].name === 'Alice' && live.winnersWanted === 3 && live.drawDate === '2026-11-01' && live.due === false);
const waiting = ML.buildView({ roster, monthlyLucky: { auto: false, pointsMonth: '2026-10', closed: st2.monthlyLucky.closed } }, {}, { nowMs: NOW, offsetHours: 8 }).months[1];
check('closed-but-undrawn month: due, eligible from the snapshot, labelled for the admin when auto is off', waiting.status === 'pending' && waiting.closed === true && waiting.due === true && waiting.counts.eligible === 2 && ML.statusLabel(waiting) === 'Waiting for admin');
check('statusLabel: auto + due → Draw pending; live → This month; done → Drawn', ML.statusLabel(Object.assign({}, waiting, { auto: true })) === 'Draw pending' && ML.statusLabel(live) === 'This month' && ML.statusLabel(done) === 'Drawn');
const pub = ML.publicMonthView(done), pubLive = ML.publicMonthView(live);
check('public view: winners + prizes, eligible names only once drawn, never points', pub.lists.winners[0].prize === 'Racket' && pub.lists.eligible.length === 3 && pub.lists.eligible[0].points === undefined && pubLive.lists.eligible.length === 0 && pubLive.counts.eligible === 3 && pub.prizes.length === 2 && pub.pool === undefined);
check('done view looks up prize photos from the CURRENT settings by id', (() => { const s = { roster, monthlyLucky: { pointsMonth: '2026-10', prizes: [{ id: 'x', name: 'Racket (renamed)', photo: 'data:image/jpeg;base64,QUJD' }] } }; const v = ML.buildView(s, { '2026-09': rec }, { nowMs: NOW }).months.find(m => m.month === '2026-09'); return v.prizes[0].name === 'Racket' && v.prizes[0].photo === 'data:image/jpeg;base64,QUJD' && v.prizes[1].photo === null; })());

// ── prize quantity + description ──
{
  const pz = ML.normalizePrizes([{ id: 'a', name: 'Tube', qty: '2', desc: '  Yonex AS-50, 12 pcs  ' }, { id: 'b', name: 'Bag', qty: 0, desc: null }, { id: 'c', name: 'Grip', qty: 150, desc: 'x'.repeat(300) }, { id: 'd', name: 'Socks', qty: 1.5 }]);
  check('normalizePrizes: qty parsed (default 1; 0 / 1.5 / 150 fall back), desc trimmed + capped', pz[0].qty === 2 && pz[0].desc === 'Yonex AS-50, 12 pcs' && pz[1].qty === 1 && pz[1].desc === '' && pz[2].qty === 1 && pz[2].desc.length === ML.MAX_PRIZE_DESC && pz[3].qty === 1);
  check('isPrizeQty bounds (whole numbers 1..99)', ML.isPrizeQty(1) && ML.isPrizeQty(99) && !ML.isPrizeQty(0) && !ML.isPrizeQty(100) && !ML.isPrizeQty(2.5) && !ML.isPrizeQty('2'));
  check('prizeLabel: bare name at qty 1, "N × name" above, empty for junk', ML.prizeLabel({ name: 'Tube' }) === 'Tube' && ML.prizeLabel({ name: 'Tube', qty: 1 }) === 'Tube' && ML.prizeLabel({ name: 'Tube', qty: 3 }) === '3 × Tube' && ML.prizeLabel({ name: ' ', qty: 3 }) === '' && ML.prizeLabel(null) === '');
  const qrec = ML.buildDrawResult({ month: '2026-09', players, winnersWanted: 3, prizes: [{ id: 'a', name: 'Tube', qty: 2, desc: 'Yonex AS-50', photo: 'data:image/jpeg;base64,QUJD' }, { id: 'b', name: 'Bag' }], seed: SEED, nowMs: 1 });
  check('record snapshots qty + desc (never the photo)', qrec.prizes[0].qty === 2 && qrec.prizes[0].desc === 'Yonex AS-50' && qrec.prizes[0].photo === undefined && qrec.prizes[1].qty === 1 && qrec.prizes[1].desc === '');
  const qa = ML.awardsOf(qrec);
  check('awardsOf: prize = label with qty, plus prizeName/qty/desc; extras empty', qa[0].prize === '2 × Tube' && qa[0].prizeName === 'Tube' && qa[0].qty === 2 && qa[0].desc === 'Yonex AS-50' && qa[1].prize === 'Bag' && qa[1].qty === 1 && qa[2].prize === '' && qa[2].qty === 0 && qa[2].desc === '');
  check('old records without qty/desc still read as qty 1, no desc', (() => { const a = ML.awardsOf({ winners: ['p1'], names: { p1: 'A' }, prizes: [{ id: 'x', name: 'Racket' }] }); return a[0].prize === 'Racket' && a[0].qty === 1 && a[0].desc === ''; })());
  const qs = { roster, monthlyLucky: { pointsMonth: '2026-10', prizes: [{ id: 'a', name: 'Tube (renamed)', qty: 5, desc: 'changed later', photo: 'data:image/jpeg;base64,QUJD' }] } };
  const qv = ML.buildView(qs, { '2026-09': qrec }, { nowMs: NOW }).months.find(m => m.month === '2026-09');
  check('done view keeps the RECORDED qty/desc; the photo still comes by id from settings', qv.prizes[0].qty === 2 && qv.prizes[0].desc === 'Yonex AS-50' && qv.prizes[0].photo === 'data:image/jpeg;base64,QUJD' && qv.lists.winners[0].prize === '2 × Tube' && qv.lists.winners[0].desc === 'Yonex AS-50');
  const qlive = ML.buildView(qs, {}, { nowMs: NOW }).months.find(m => m.month === '2026-10');
  check('pending view carries qty/desc from the current settings', qlive.prizes[0].qty === 5 && qlive.prizes[0].desc === 'changed later');
  const qpub = ML.publicMonthView(qv);
  check('public view exposes qty/desc/prizeName on winners and prizes', qpub.lists.winners[0].qty === 2 && qpub.lists.winners[0].desc === 'Yonex AS-50' && qpub.lists.winners[0].prizeName === 'Tube' && qpub.prizes[0].qty === 2 && qpub.prizes[0].desc === 'Yonex AS-50');
  // ── one place, several different prizes ──
  check('isPlace / placeOf: an explicit place wins, junk falls back to the row position',
    ML.isPlace(1) && ML.isPlace(12) && !ML.isPlace(0) && !ML.isPlace(13) && !ML.isPlace(1.5)
    && ML.placeOf({ place: 3 }, 0) === 3 && ML.placeOf({}, 1) === 2 && ML.placeOf({ place: 0 }, 4) === 5 && ML.placeOf({ place: 'x' }, 0) === 1);
  const mpz = ML.normalizePrizes([{ id: 'pzA', name: 'Bag', place: 1 }, { id: 'pzB', name: 'Tube', qty: 2, place: 1 }, { id: 'pzC', name: 'Socks', place: 2 }]);
  check('normalizePrizes keeps the place; rows with none keep their position', mpz.map(p => p.place).join(',') === '1,1,2'
    && ML.normalizePrizes([{ id: 'pzA', name: 'A' }, { id: 'pzB', name: 'B' }]).map(p => p.place).join(',') === '1,2');
  const mrec = ML.buildDrawResult({ month: '2026-09', players, winnersWanted: 3, prizes: mpz, seed: SEED, nowMs: 1 });
  const ma = ML.awardsOf(mrec);
  check('awardsOf: 1st takes both prizes at place 1, 2nd takes place 2, 3rd gets none',
    ma[0].prize === 'Bag + 2 × Tube' && ma[0].prizes.map(p => p.label).join('|') === 'Bag|2 × Tube'
    && ma[1].prize === 'Socks' && ma[1].prizes.length === 1 && ma[2].prize === '' && ma[2].prizes.length === 0);
  check('awardsOf: the single-prize fields still describe the first prize of that place',
    ma[0].prizeId === 'pzA' && ma[0].prizeName === 'Bag' && ma[0].qty === 1);
  check('the record remembers the places it was drawn with', mrec.prizes.map(p => p.place).join(',') === '1,1,2');
  check('a record drawn before places existed is still read positionally', (() => {
    const a = ML.awardsOf({ winners: ['p1', 'p2'], names: { p1: 'A', p2: 'B' }, prizes: [{ id: 'x', name: 'Racket' }, { id: 'y', name: 'Socks' }] });
    return a[0].prize === 'Racket' && a[1].prize === 'Socks' && a[0].prizes.length === 1;
  })());
  const mpub = ML.publicMonthView(ML.buildView({ roster, monthlyLucky: { prizes: mpz } }, { '2026-09': mrec }, { nowMs: NOW }).months.find(m => m.month === '2026-09'));
  check('public view carries every prize of a place, and the place on each tile',
    mpub.lists.winners[0].prizes.map(p => p.label).join('|') === 'Bag|2 × Tube' && mpub.prizes.map(p => p.place).join(',') === '1,1,2');
  check('the poll-safe settings carry the place too', ML.liteOf({ prizes: mpz }, '2026-09-11').prizes.map(p => p.place).join(',') === '1,1,2');

  const qlite = ML.liteOf({ prizes: [{ id: 'a', name: 'Tube', qty: 2, desc: 'd', photo: 'data:image/jpeg;base64,QUJD' }] }, '2026-09-11');
  check('liteOf carries qty + desc but still no photo bytes', qlite.prizes[0].qty === 2 && qlite.prizes[0].desc === 'd' && qlite.prizes[0].photo === undefined && qlite.prizes[0].hasPhoto === true);
}

// ── copy ──
check('howItWorksText mentions threshold, winners, schedule and the reset', /Reach 80 points/.test(ML.howItWorksText({})) && /3 winners are picked/.test(ML.howItWorksText({})) && /9:00 AM on the 1st/.test(ML.howItWorksText({})) && /from zero every month/.test(ML.howItWorksText({})));
check('howItWorksText with auto off says an admin runs it; singular winner', /when an admin runs the draw/.test(ML.howItWorksText({ auto: false })) && /1 winner is picked/.test(ML.howItWorksText({ winners: 1 })));
check('drawTimeLabel', ML.drawTimeLabel() === '9:00 AM');

console.log('monthly lucky (pure): ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
