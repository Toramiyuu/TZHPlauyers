#!/usr/bin/env node
/* Tests for per-player session payments: the pure module (public/payments.js) and the
 * server handlers (lib/payments.js) with an injected clock. Covers the four behaviours
 * the spec calls out — idempotent generation, uniqueness, paidAt set/cleared, amount
 * follows tier unless overridden — plus validation and the read helpers the UI uses. */
'use strict';
const P = require('../public/payments.js');
const H = require('../lib/payments.js');
const W = require('../lib/weekly.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

const NOW = Date.UTC(2026, 8, 7, 13, 42);            // Mon 2026-09-07 21:42 MYT
const DATE = '2026-09-07';
function freshState(over) {
  return Object.assign({
    roster: [{ id: 'p0', name: 'Thomas' }, { id: 'p1', name: 'Desmond' }, { id: 'p2', name: 'Celine' }, { id: 'p3', name: 'Sharmin' }],
    players: [{ id: 'p0', name: 'Thomas' }, { id: 'p1', name: 'Desmond' }, { id: 'p2', name: 'Celine' }],
    sessionDate: DATE, sessions: {}, signups: [], regulars: {}, feeTier: '3h',
    monthlyDraw: { month: '2026-09', participants: [] },
    attendance: {}, audit: [],
  }, over || {});
}
const gen = (s, date, now) => H.handlePaymentAdminAction(s, { action: 'generatePayments', date: date || DATE }, { nowMs: now || NOW });
const set = (s, body, now) => H.handlePaymentAdminAction(s, Object.assign({ action: 'setPayment', date: DATE }, body), { nowMs: now || NOW });

// ── 1. idempotent generation ──
{
  const s = freshState();
  let r = gen(s);
  check('gen: ok + changed', r.status === 200 && r.body.ok === true && r.changed === true);
  check('gen: created 3, existed 0, total 3', r.body.created === 3 && r.body.existed === 0 && r.body.total === 3);
  check('gen: tier from session (3h)', r.body.tier === '3h');
  check('gen: entries map returned', r.body.entries && r.body.entries.p0 && r.body.entries.p0.payment);
  const e0 = s.attendance[DATE].entries.p0;
  check('gen: record shape', e0.present === true && e0.paid === false && e0.source === 'session'
    && e0.payment.fee === 25 && e0.payment.tier === '3h' && e0.payment.method === null && e0.payment.paidAt === null
    && e0.payment.markedBy === null && e0.payment.feeOverridden === false && e0.payment.createdAt === NOW && e0.payment.updatedAt === NOW);
  check('gen: day meta', s.attendance[DATE].payments && s.attendance[DATE].payments.tier === '3h' && s.attendance[DATE].payments.generatedAt === NOW);
  check('gen: audit entry', s.audit.some(a => a.action === 'payments.generate' && a.newValue.created === 3));
  check('gen: summary text', P.eodSummaryText(r.body.created, r.body.existed) === 'Generated 3 payment records, 0 already existed');

  // mark one paid + override one fee, then press again
  set(s, { playerId: 'p0', paid: true, method: 'cash' });
  set(s, { playerId: 'p1', fee: 15 });
  const before = JSON.stringify(s.attendance[DATE].entries);
  r = gen(s, DATE, NOW + 60000);
  check('gen twice: created 0, existed 3, not changed', r.body.created === 0 && r.body.existed === 3 && r.changed === false);
  check('gen twice: existing records byte-for-byte untouched', JSON.stringify(s.attendance[DATE].entries) === before);
  check('gen twice: day meta keeps first generatedAt', s.attendance[DATE].payments.generatedAt === NOW);

  // a late player joins the line-up → only the missing record is created
  s.players.push({ id: 'p3', name: 'Sharmin' });
  r = gen(s, DATE, NOW + 120000);
  check('gen after new player: created 1, existed 3', r.body.created === 1 && r.body.existed === 3 && r.changed === true);
  check('gen after new player: others untouched (p0 still paid cash, p1 still RM15)',
    s.attendance[DATE].entries.p0.paid === true && s.attendance[DATE].entries.p0.payment.method === 'cash'
    && s.attendance[DATE].entries.p1.payment.fee === 15 && s.attendance[DATE].entries.p1.payment.feeOverridden === true);
  check('gen after new player: new record at now', s.attendance[DATE].entries.p3.payment.createdAt === NOW + 120000);
}

// ── 1b. second press reconciles against the ticked line-up ──
{
  const s = freshState();
  gen(s);
  set(s, { playerId: 'p0', paid: true, method: 'cash' });      // Thomas paid
  // Harvey-style: Desmond (p1) was ticked at the start but could not make it → unticked.
  s.players = s.players.filter(p => p.id !== 'p1');
  // Thomas (p0) also unticked by mistake — but he paid, so his record must stay.
  s.players = s.players.filter(p => p.id !== 'p0');
  // Sharmin (p3) joined late.
  s.players.push({ id: 'p3', name: 'Sharmin' });
  // A manual attendance mark (not End-of-day-made) for someone off the line-up must survive.
  s.attendance[DATE].entries.p9 = { playerId: 'p9', name: 'Guest', present: true, paid: false, source: 'manual', payment: P.newPayment('3h', NOW) };
  const r = gen(s, DATE, NOW + 60000);
  check('reconcile: unticked unpaid player is removed, late joiner added', r.body.removed === 1 && r.body.removedNames.join() === 'Desmond' && r.body.created === 1 && !s.attendance[DATE].entries.p1 && s.attendance[DATE].entries.p3);
  check('reconcile: unticked but PAID player is kept and reported', r.body.keptPaid.join() === 'Thomas' && s.attendance[DATE].entries.p0 && s.attendance[DATE].entries.p0.paid === true);
  check('reconcile: manual attendance record survives', s.attendance[DATE].entries.p9 && s.attendance[DATE].entries.p9.payment);
  check('reconcile: counts (line-up only) + changed + audit note', r.body.existed === 1 && r.body.total === 2 && r.changed === true && /Removed \(unticked\): Desmond/.test(s.audit[0].note) && s.audit[0].newValue.removed === 1);
  check('reconcile: summary text mentions the removal', P.eodSummaryText(r.body.created, r.body.existed, r.body.removed) === 'Generated 1 payment record, 1 already existed, 1 removed (no longer in the line-up)');
  const again = gen(s, DATE, NOW + 120000);
  check('reconcile: third press with nothing changed → no-op', again.body.created === 0 && again.body.removed === 0 && again.changed === false);
  // Pure helper never mutates its input
  const entries = { a: { playerId: 'a', name: 'A', paid: false, source: 'session', payment: {} } };
  const out = P.reconcileInto(entries, []);
  check('reconcileInto: input untouched, removal reported', entries.a && !out.entries.a && out.removed[0].id === 'a' && out.keptPaid.length === 0);
}

// ── 2. unique constraint (one record per player per session) ──
{
  const s = freshState({ players: [{ id: 'p0', name: 'Thomas' }, { id: 'p0', name: 'Thomas dup' }, { id: 'p1', name: 'Desmond' }] });
  const r = gen(s);
  check('unique: duplicate ids in line-up → one record each', r.body.created === 2 && Object.keys(s.attendance[DATE].entries).length === 2);
  check('unique: map keyed by playerId', Object.keys(s.attendance[DATE].entries).sort().join() === 'p0,p1');
  const r404 = set(s, { playerId: 'p9', paid: true });
  check('unique: setPayment never creates a record (404)', r404.status === 404 && !s.attendance[DATE].entries.p9);
  gen(s); gen(s);
  check('unique: three presses still 2 records', Object.keys(s.attendance[DATE].entries).length === 2);
  // Pure helper: generateInto never mutates its input
  const entries = { p0: { playerId: 'p0', name: 'T', present: true, paid: false, source: 'session' } };
  const out = P.generateInto(entries, [{ id: 'p0', name: 'T' }], '3h', NOW);
  check('generateInto: input untouched', entries.p0.payment === undefined && out.entries.p0.payment.fee === 25);
  // Existing attendance entry WITHOUT a record (e.g. seeded from Weekly tab) keeps present/paid, gains payment
  const s2 = freshState();
  W.handleWeeklyAdminAction(s2, { action: 'setAttendance', date: DATE, playerId: 'p0', name: 'Thomas', present: false, paid: true });
  gen(s2);
  const e = s2.attendance[DATE].entries.p0;
  check('gen over seeded entry: keeps present=false paid=true, adds payment', e.present === false && e.paid === true && !!e.payment);
  check('gen over already-paid entry: paidAt backfilled at generation time', e.payment.paidAt === NOW && e.payment.markedBy === 'admin');
}

// ── 3. paidAt set and cleared ──
{
  const s = freshState();
  gen(s);
  let r = set(s, { playerId: 'p0', paid: true, method: 'tng' }, NOW + 1000);
  let e = r.body.entry;
  check('paid: ok + changed', r.status === 200 && r.changed === true);
  check('paid: paidAt = now, markedBy admin, method tng', e.paid === true && e.payment.paidAt === NOW + 1000 && e.payment.markedBy === 'admin' && e.payment.method === 'tng');
  check('paid: updatedAt bumped', e.payment.updatedAt === NOW + 1000);
  check('paid: audit paid + method', s.audit.some(a => a.action === 'payment.paid' && a.newValue === true) && s.audit.some(a => a.action === 'payment.method' && a.newValue === 'tng'));
  r = set(s, { playerId: 'p0', paid: true, method: 'cash' }, NOW + 5000);
  e = r.body.entry;
  check('paid again (method change): paidAt preserved', e.payment.paidAt === NOW + 1000 && e.payment.method === 'cash');
  r = set(s, { playerId: 'p0', paid: true, method: 'cash' }, NOW + 6000);
  check('same patch: unchanged, no write', r.changed === false && r.body.unchanged === true);
  r = set(s, { playerId: 'p0', paid: false }, NOW + 9000);
  e = r.body.entry;
  check('unpaid: paidAt/markedBy/method cleared', e.paid === false && e.payment.paidAt === null && e.payment.markedBy === null && e.payment.method === null);
  check('unpaid: audit paid false', s.audit.some(a => a.action === 'payment.paid' && a.newValue === false));
  // Weekly tab checkbox path (setAttendance) keeps the payment record and stamps paidAt
  r = W.handleWeeklyAdminAction(s, { action: 'setAttendance', date: DATE, playerId: 'p1', paid: true });
  e = s.attendance[DATE].entries.p1;
  check('weekly setAttendance paid: payment kept + paidAt stamped', r.status === 200 && !!e.payment && typeof e.payment.paidAt === 'number' && e.paid === true);
  W.handleWeeklyAdminAction(s, { action: 'setAttendance', date: DATE, playerId: 'p1', paid: false });
  e = s.attendance[DATE].entries.p1;
  check('weekly setAttendance unpaid: paidAt cleared, payment kept', e.paid === false && e.payment.paidAt === null && e.payment.fee === 25);
  W.handleWeeklyAdminAction(s, { action: 'setAttendance', date: DATE, playerId: 'p1', present: false });
  check('weekly setAttendance present-only: payment untouched', s.attendance[DATE].entries.p1.payment.fee === 25);
  // paid change feeds monthly eligibility recompute (same hook as attendance)
  check('paid change recomputed monthly eligibility', s.monthlyEligibility && s.monthlyEligibility.month === '2026-09');
}

// ── 4. amount follows tier unless overridden ──
{
  const s = freshState({ feeTier: '2h' });
  gen(s);
  let e = s.attendance[DATE].entries.p0;
  check('tier: session 2h → RM20', e.payment.tier === '2h' && e.payment.fee === 20);
  e = set(s, { playerId: 'p0', tier: '3h' }).body.entry;
  check('tier change → fee follows (25)', e.payment.tier === '3h' && e.payment.fee === 25 && e.payment.feeOverridden === false);
  check('tier audit', s.audit.some(a => a.action === 'payment.tier' && a.newValue === '3h') && s.audit.some(a => a.action === 'payment.fee' && a.newValue === 25));
  e = set(s, { playerId: 'p0', fee: 15 }).body.entry;
  check('override → RM15, feeOverridden', e.payment.fee === 15 && e.payment.feeOverridden === true);
  e = set(s, { playerId: 'p0', tier: '2h' }).body.entry;
  check('tier change after override → fee stays 15', e.payment.tier === '2h' && e.payment.fee === 15 && e.payment.feeOverridden === true);
  e = set(s, { playerId: 'p0', resetFee: true }).body.entry;
  check('resetFee → back to tier amount (20)', e.payment.fee === 20 && e.payment.feeOverridden === false);
  e = set(s, { playerId: 'p0', fee: 20 }).body.entry;
  check('override equal to tier amount → not overridden', e.payment.fee === 20 && e.payment.feeOverridden === false);
  e = set(s, { playerId: 'p0', fee: 22.5 }).body.entry;
  check('override 2dp', e.payment.fee === 22.5 && e.payment.feeOverridden === true);
  e = set(s, { playerId: 'p0', fee: '18' }).body.entry;
  check('override string number coerced', e.payment.fee === 18);
  // collected sums use the overridden fee
  set(s, { playerId: 'p0', paid: true, method: 'cash' });
  set(s, { playerId: 'p1', paid: true, method: 'duitnow' });
  const sum = P.summarize(s.attendance[DATE].entries);
  check('summarize: players 3, paid 2, unpaid 1, collected 18+20', sum.players === 3 && sum.paid === 2 && sum.unpaid === 1 && sum.collected === 38);
}

// ── 5. validation / contract ──
{
  const s = freshState();
  check('gen bad date → 400', gen(s, 'nope').status === 400);
  check('gen no players → ok:false, not changed', (() => { const r = gen(freshState({ players: [] })); return r.status === 200 && r.body.ok === false && r.changed === false && r.body.created === 0; })());
  check('gen past date uses snapshot players + snapshot tier', (() => {
    const s2 = freshState({ sessionDate: '2026-09-09', sessions: { [DATE]: { players: [{ id: 'p2', name: 'Celine' }], rounds: [], feeTier: '2h' } } });
    const r = gen(s2, DATE);
    return r.body.created === 1 && r.body.tier === '2h' && s2.attendance[DATE].entries.p2.payment.fee === 20;
  })());
  gen(s);
  check('set bad method → 400', set(s, { playerId: 'p0', method: 'card' }).status === 400);
  check('set bad tier → 400', set(s, { playerId: 'p0', tier: '4h' }).status === 400);
  check('set negative fee → 400', set(s, { playerId: 'p0', fee: -1 }).status === 400);
  check('set NaN fee → 400', set(s, { playerId: 'p0', fee: 'abc' }).status === 400);
  check('set missing player → 400', set(s, {}).status === 400);
  check('set bad date → 400', H.handlePaymentAdminAction(s, { action: 'setPayment', date: 'x', playerId: 'p0', paid: true }).status === 400);
  check('unknown action → 400', H.handlePaymentAdminAction(s, { action: 'nope' }).status === 400);
  check('null state → 400 (no throw)', H.handlePaymentAdminAction(null, { action: 'generatePayments', date: DATE }).status === 400);
  check('method null allowed', set(s, { playerId: 'p0', method: null }).status === 200);
  check('paid set without a method is allowed (method stays null)', (() => { const r = set(s, { playerId: 'p2', paid: true }); return r.status === 200 && r.body.entry.paid === true && r.body.entry.payment.method === null; })());
}

// ── 6. pure read helpers used by the UI ──
{
  const s = freshState();
  gen(s);
  set(s, { playerId: 'p2', paid: true, method: 'cash' });
  const entries = s.attendance[DATE].entries;
  const rows = P.rowsOf(entries);
  check('rowsOf: unpaid first, then name order (Desmond, Thomas, then paid Celine)', rows.map(r => r.name).join() === 'Desmond,Thomas,Celine');
  check('rowsOf: all paid → plain name order', (() => { const c = JSON.parse(JSON.stringify(entries)); c.p0.paid = c.p1.paid = true; return P.rowsOf(c).map(r => r.name).join() === 'Celine,Desmond,Thomas'; })());
  check('rowsOf: paid filter keeps name order', (() => { const c = JSON.parse(JSON.stringify(entries)); c.p0.paid = true; return P.rowsOf(c, { filter: 'paid' }).map(r => r.name).join() === 'Celine,Thomas'; })());
  check('rowsOf unpaidOnly', P.rowsOf(entries, { unpaidOnly: true }).map(r => r.name).join() === 'Desmond,Thomas');
  check('rowsOf ignores entries without payment', P.rowsOf({ x: { playerId: 'x', name: 'X', paid: true } }).length === 0);
  check('nextPaymentPatch cash', JSON.stringify(P.nextPaymentPatch(entries.p0, 'cash')) === '{"paid":true,"method":"cash"}');
  check('nextPaymentPatch tng', JSON.stringify(P.nextPaymentPatch(entries.p0, 'tng')) === '{"paid":true,"method":"tng"}');
  check('nextPaymentPatch duitnow', JSON.stringify(P.nextPaymentPatch(entries.p0, 'duitnow')) === '{"paid":true,"method":"duitnow"}');
  check('nextPaymentPatch qr no longer a method → null', P.nextPaymentPatch(entries.p0, 'qr') === null);
  check('method labels', P.methodLabel('tng') === 'TnG' && P.methodLabel('duitnow') === 'DuitNow' && P.methodLabel('cash') === 'Cash');
  check('nextPaymentPatch unpaid', JSON.stringify(P.nextPaymentPatch(entries.p0, 'unpaid')) === '{"paid":false,"method":null}');
  check('nextPaymentPatch unknown → null', P.nextPaymentPatch(entries.p0, 'card') === null);
  check('isNoopPatch: same state', P.isNoopPatch(entries.p2, { paid: true, method: 'cash' }) === true);
  check('isNoopPatch: change', P.isNoopPatch(entries.p2, { paid: true, method: 'tng' }) === false && P.isNoopPatch(entries.p0, { paid: true, method: 'cash' }) === false);
  check('isNoopPatch: resetFee on tier fee is noop', P.isNoopPatch(entries.p0, { resetFee: true }) === true);
  const att = { '2026-09-04': { entries: { p0: { payment: {} } } }, '2026-09-07': { entries: entries }, '2026-09-02': { entries: { p0: { paid: true } } } };
  check('datesWithPayments: newest first, skips days without records', P.datesWithPayments(att).join() === '2026-09-07,2026-09-04');
  const dates = ['2026-09-07', '2026-09-04', '2026-09-01'];
  check('stepDate older', P.stepDate(dates, '2026-09-07', -1) === '2026-09-04');
  check('stepDate newer at newest → null', P.stepDate(dates, '2026-09-07', 1) === null);
  check('stepDate older at oldest → null', P.stepDate(dates, '2026-09-01', -1) === null);
  check('stepDate unknown current → first', P.stepDate(dates, 'x', 1) === '2026-09-07');
  check('feeTierForDate live', P.feeTierForDate({ sessionDate: DATE, feeTier: '2h' }, DATE) === '2h');
  check('feeTierForDate snapshot', P.feeTierForDate({ sessionDate: 'x', sessions: { [DATE]: { feeTier: '2h' } } }, DATE) === '2h');
  check('feeTierForDate missing → default', P.feeTierForDate({}, DATE) === '3h' && P.tierOf('junk') === '3h');
  check('summarize empty', JSON.stringify(P.summarize({})) === '{"players":0,"paid":0,"unpaid":0,"collected":0,"expected":0,"outstanding":0}');
  {
    const s6 = freshState(); gen(s6);
    set(s6, { playerId: 'p0', paid: true, method: 'cash' });
    set(s6, { playerId: 'p1', tier: '2h' }); set(s6, { playerId: 'p1', paid: true, method: 'tng' });
    const en = s6.attendance[DATE].entries;
    const sum = P.summarize(en);
    check('summarize expected/outstanding (25+20+25 expected, 45 collected)', sum.expected === 70 && sum.collected === 45 && sum.outstanding === 25);
    const bd = P.breakdownByMethod(en);
    check('breakdownByMethod: fixed METHODS order with counts + amounts + names', bd.map(r => r.method).join() === 'cash,tng,duitnow' && bd[0].count === 1 && bd[0].amount === 25 && bd[0].names.join() === 'Thomas' && bd[1].count === 1 && bd[1].amount === 20 && bd[1].names.join() === 'Desmond' && bd[2].count === 0 && bd[2].amount === 0 && bd[2].names.length === 0);
    W.handleWeeklyAdminAction(s6, { action: 'setAttendance', date: DATE, playerId: 'p2', paid: true }); // paid via the Weekly checkbox: no method
    check('breakdownByMethod: paid without a method lands in Unspecified', P.breakdownByMethod(en).some(r => r.method === 'other' && r.count === 1 && r.amount === 25));
    check('rowsOf filters: paid / unpaid / method', P.rowsOf(en, { filter: 'paid' }).length === 3 && P.rowsOf(en, { filter: 'unpaid' }).length === 0 && P.rowsOf(en, { filter: 'tng' }).map(e => e.name).join() === 'Desmond' && P.rowsOf(en, { filter: 'cash' }).map(e => e.name).join() === 'Thomas' && P.rowsOf(en, { filter: 'duitnow' }).length === 0);
    set(s6, { playerId: 'p2', paid: false });
    check('unpaidNames', P.unpaidNames(en).join() === 'Celine');
    check('FILTERS + labels', P.FILTERS.join() === 'all,unpaid,paid,cash,tng,duitnow' && P.filterLabel('tng') === 'TnG' && P.filterLabel('unpaid') === 'Unpaid' && P.isFilter('card') === false);
  }
  check('eodSummaryText singular', P.eodSummaryText(1, 0) === 'Generated 1 payment record, 0 already existed');
  check('eodSummaryText none', /Nothing to generate/.test(P.eodSummaryText(0, 0)));
  check('eodStatusText', P.eodStatusText({ players: 20, paid: 12, unpaid: 8 }) === '20 records · 12 paid' && P.eodStatusText({ players: 3, paid: 3, unpaid: 0 }) === '3 records · all paid' && P.eodStatusText({ players: 0 }) === '');
  check('fmtRM', P.fmtRM(25) === 'RM25' && P.fmtRM(22.5) === 'RM22.50' && P.fmtRM(0) === 'RM0');
  check('feeLabel (amount only; tier has its own control)', P.feeLabel({ fee: 25, tier: '3h' }) === 'RM25' && P.feeLabel({ fee: 15, tier: '3h', feeOverridden: true }) === 'RM15 · custom');
  check('feeTierLabel', P.feeTierLabel({ fee: 25, tier: '3h' }) === 'RM25 · 3h' && P.feeTierLabel({ fee: 15, tier: '3h', feeOverridden: true }) === 'RM15 · custom');
  check('parseFeeInput', P.parseFeeInput('RM25') === 25 && P.parseFeeInput(' 22.5 ') === 22.5 && P.parseFeeInput('abc') === null && P.parseFeeInput('-3') === null && P.parseFeeInput('') === null && P.parseFeeInput('1000') === null);
  check('paidLine', P.paidLine(entries.p2, () => '9:42 PM') === 'Paid 9:42 PM · Cash' && P.paidLine(entries.p0) === '');
}

// ── 7. Malaysia time ──
{
  const t = Date.UTC(2026, 8, 9, 13, 42);           // 21:42 MYT
  check('fmtMYT 9:42 PM', P.fmtMYT(t) === '9:42 PM');
  check('fmtMYT midnight boundary (16:00Z → 12:00 AM next day)', P.fmtMYT(Date.UTC(2026, 8, 9, 16, 0)) === '12:00 AM');
  check('fmtMYTDateTime', P.fmtMYTDateTime(t) === '9 Sep · 9:42 PM');
  check('fmtMYTDateTime crosses date at MYT midnight', P.fmtMYTDateTime(Date.UTC(2026, 8, 9, 16, 5)) === '10 Sep · 12:05 AM');
  check('fmtMYT empty', P.fmtMYT(null) === '' && P.fmtMYT(0) === '');
  // paid within 3 days: Mon 2026-09-07 session → allowed until Thu 2026-09-10 23:59:59 MYT
  const mk = (paidAt) => ({ paid: true, payment: { paidAt } });
  const lastOk = Date.UTC(2026, 8, 10, 15, 59);     // Thu 23:59 MYT
  const firstBad = Date.UTC(2026, 8, 10, 16, 1);    // Fri 00:01 MYT
  check('paidWithin: D+3 23:59 MYT → true', P.paidWithin(mk(lastOk), DATE, 3) === true);
  check('paidWithin: D+4 00:01 MYT → false', P.paidWithin(mk(firstBad), DATE, 3) === false);
  check('paidWithin: on the night → true', P.paidWithin(mk(NOW), DATE, 3) === true);
  check('paidWithin: unpaid/no record → false', P.paidWithin({ paid: false, payment: { paidAt: NOW } }, DATE, 3) === false && P.paidWithin({ paid: true }, DATE, 3) === false);
}

// ── 8. Member ledger (Payments "By member" view) + keep-while-owing retention ──
{
  const DAY = 86400000;
  const s = freshState({ roster: [{ id: 'p0', name: 'Thomas' }, { id: 'p1', name: 'Desmond' }, { id: 'p2', name: 'Celine' }, { id: 'p3', name: 'Sharmin' }] });
  // Night A = tonight (2026-09-07, 3h): Thomas, Desmond, Celine. Thomas pays cash.
  gen(s, DATE);
  set(s, { playerId: 'p0', paid: true, method: 'cash' });
  // Night B (2026-09-04, 2h): Thomas, Desmond and an ex-member who has since left the roster. Desmond pays TnG.
  s.sessions['2026-09-04'] = { players: [{ id: 'p0', name: 'Thomas' }, { id: 'p1', name: 'Desmond' }, { id: 'px', name: 'Old Mate' }], feeTier: '2h' };
  gen(s, '2026-09-04', NOW - 3 * DAY);
  H.handlePaymentAdminAction(s, { action: 'setPayment', date: '2026-09-04', playerId: 'p1', paid: true, method: 'tng' }, { nowMs: NOW - 2 * DAY });
  // Night C (2026-08-31, 3h): Celine only, custom RM15, unpaid.
  s.sessions['2026-08-31'] = { players: [{ id: 'p2', name: 'Celine' }], feeTier: '3h' };
  gen(s, '2026-08-31', NOW - 7 * DAY);
  H.handlePaymentAdminAction(s, { action: 'setPayment', date: '2026-08-31', playerId: 'p2', fee: 15 }, { nowMs: NOW - 7 * DAY });
  const att = s.attendance;

  const th = P.memberSessions(att, 'p0');
  check('memberSessions: newest first, only nights with a record', th.length === 2 && th[0].date === DATE && th[1].date === '2026-09-04');
  const mt = P.memberSummary(att, 'p0', 'Thomas');
  check('memberSummary: Thomas owes RM20 (B, 2h) and settled RM25 (A, cash)',
    mt.outstanding === 20 && mt.unpaidCount === 1 && mt.owing[0].date === '2026-09-04' && mt.owing[0].tier === '2h' && mt.owing[0].paid === false
    && mt.paidCount === 1 && mt.paidTotal === 25 && mt.settled[0].date === DATE && mt.settled[0].method === 'cash' && mt.settled[0].paidAt === NOW && mt.settled[0].paid === true);
  const md = P.memberSummary(att, 'p1', 'Desmond');
  check('memberSummary: Desmond owes RM25 (A), settled RM20 (B, TnG)', md.outstanding === 25 && md.owing[0].date === DATE && md.settled[0].date === '2026-09-04' && md.settled[0].method === 'tng');
  const mc = P.memberSummary(att, 'p2', 'Celine');
  check('memberSummary: Celine owes RM40 across 2 nights, custom amount flagged', mc.outstanding === 40 && mc.unpaidCount === 2 && mc.owing[0].date === DATE && mc.owing[1].date === '2026-08-31' && mc.owing[1].fee === 15 && mc.owing[1].feeOverridden === true);
  const msh = P.memberSummary(att, 'p3', 'Sharmin');
  check('memberSummary: no records → zeroes, name kept', msh.sessions === 0 && msh.outstanding === 0 && msh.owing.length === 0 && msh.settled.length === 0 && msh.name === 'Sharmin');
  check('memberSummary: name falls back to the record, then to the id', P.memberSummary(att, 'px').name === 'Old Mate' && P.memberSummary(att, 'nobody').name === 'nobody');

  const L = P.memberLedger(att, s.roster);
  check('memberLedger: every roster player + ex-roster players with records', L.length === 5 && L.some(m => m.playerId === 'px') && L.some(m => m.playerId === 'p3'));
  check('memberLedger: owing first (largest debt on top, name tiebreak), then no-records', L.map(m => m.name).join(',') === 'Celine,Desmond,Old Mate,Thomas,Sharmin');
  check('memberLedger: roster name wins over the name stored on records', P.memberLedger(att, [{ id: 'p1', name: 'Desmond L.' }]).find(m => m.playerId === 'p1').name === 'Desmond L.');
  check('memberLedger: tolerates junk input', P.memberLedger(null, null).length === 0 && P.memberLedger({ x: null, y: {} }, [{ id: 'a', name: 'A' }]).length === 1);

  check('MEMBER_FILTERS + labels', P.MEMBER_FILTERS.join() === 'all,owing,settled' && P.memberFilterLabel('owing') === 'Owing' && P.memberFilterLabel('settled') === 'Settled' && P.memberFilterLabel('zzz') === 'All members' && P.isMemberFilter('settled') === true && P.isMemberFilter('paid') === false);
  check('filterMembers: owing / settled / all', P.filterMembers(L, { filter: 'owing' }).length === 4 && P.filterMembers(L, { filter: 'settled' }).length === 0 && P.filterMembers(L).length === 5);
  check('filterMembers: case-insensitive substring search, blank query = everyone', P.filterMembers(L, { query: 'CEL' }).map(m => m.name).join() === 'Celine' && P.filterMembers(L, { query: '  ' }).length === 5 && P.filterMembers(L, { filter: 'owing', query: 'mate' }).length === 1);
  const T = P.ledgerTotals(L);
  check('ledgerTotals', T.members === 5 && T.withRecords === 4 && T.owing === 4 && T.outstanding === 105);
  check('memberOweLabel', P.memberOweLabel(mc) === 'RM40 · 2 nights' && P.memberOweLabel(mt) === 'RM20 · 1 night' && P.memberOweLabel(msh) === 'No records yet' && P.memberOweLabel(null) === '');

  // Thomas settles night B from the popup → moves to the settled group, still ahead of no-records
  H.handlePaymentAdminAction(s, { action: 'setPayment', date: '2026-09-04', playerId: 'p0', paid: true, method: 'duitnow' }, { nowMs: NOW });
  const L2 = P.memberLedger(s.attendance, s.roster);
  check('settled member: label, filter, sorted after owing and before no-records', P.memberOweLabel(L2.find(m => m.playerId === 'p0')) === 'Settled' && P.filterMembers(L2, { filter: 'settled' }).length === 1 && L2.map(m => m.name).join(',') === 'Celine,Desmond,Old Mate,Thomas,Sharmin');
  check('ledgerTotals after settling', P.ledgerTotals(L2).owing === 3 && P.ledgerTotals(L2).outstanding === 85);

  check('dayHasOutstanding', P.dayHasOutstanding(s.attendance['2026-08-31']) === true && P.dayHasOutstanding(s.attendance['2026-09-04']) === true
    && P.dayHasOutstanding({ entries: { a: { paid: true, payment: {} } } }) === false && P.dayHasOutstanding({ entries: { a: { paid: false } } }) === false
    && P.dayHasOutstanding(null) === false && P.dayHasOutstanding({}) === false);

  // Retention: a night older than 100 days survives while someone on it still owes, and only goes once settled.
  const OLD = '2026-05-01'; // cutoff for 2026-09-07 is 2026-05-30
  const rec = (paid) => ({ playerId: 'p2', name: 'Celine', present: true, paid, payment: Object.assign(P.newPayment('3h', 1), paid ? { paidAt: 2, markedBy: 'admin' } : {}) });
  s.attendance[OLD] = { date: OLD, weekday: 5, updatedAt: 0, entries: { p2: rec(false), p0: rec(true) } };
  s.attendance['2026-05-02'] = { date: '2026-05-02', weekday: 6, updatedAt: 0, entries: { p2: rec(true) } };
  s.attendance['2026-05-03'] = { date: '2026-05-03', weekday: 0, updatedAt: 0, entries: { p2: { playerId: 'p2', name: 'Celine', present: true, paid: false } } }; // attendance only
  W.pruneWeeklyState(s, DATE);
  check('prune: old night with an unpaid record is kept', !!s.attendance[OLD]);
  check('prune: old night where everyone paid is dropped', !s.attendance['2026-05-02']);
  check('prune: old attendance-only night (no payment records) is dropped', !s.attendance['2026-05-03']);
  check('prune: recent nights untouched', !!s.attendance[DATE] && !!s.attendance['2026-09-04'] && !!s.attendance['2026-08-31']);
  check('ledger still shows the old debt', P.memberSummary(s.attendance, 'p2').unpaidCount === 3 && P.memberSummary(s.attendance, 'p2').outstanding === 65);
  s.attendance[OLD].entries.p2 = P.applyPaid(s.attendance[OLD].entries.p2, true, NOW, 'admin');
  W.pruneWeeklyState(s, DATE);
  check('prune: once settled, the old night falls away on the next prune', !s.attendance[OLD]);
}

console.log(`\npayments: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
