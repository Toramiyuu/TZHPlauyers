#!/usr/bin/env node
/*
 * test-night-migrate.js — guard for the one-time phantom-night cleanup
 * (added 2026-09-16 alongside public/night.js).
 *
 * Reconstructs the exact damage the old 00:00 rollover did: a Friday session
 * still on court at 12:30am gets flipped to Saturday, so the End-of-the-day
 * press and every payment ticked after midnight land on a SATURDAY attendance
 * record — a day nobody plays on. planNightMerge folds those back into Friday;
 * applyNightMerge does it; doing it twice must be a no-op.
 *
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { planNightMerge, applyNightMerge } = require(path.join(ROOT, 'lib', 'night-migrate.js'));

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };
const eq = (name, got, want) => check(name + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')', got === want);

const FRI = '2026-09-18', SAT = '2026-09-19', SUN = '2026-09-20', MON = '2026-09-21', TUE = '2026-09-22';

function entry(id, name, paid, fee) {
  return { playerId: id, name, present: true, paid: !!paid,
    payment: { fee: fee == null ? 25 : fee, tier: '3h', method: paid ? 'cash' : null, paidAt: paid ? 1758200000000 : null, markedBy: paid ? 'admin' : null, feeOverridden: false } };
}

// ── the damaged state ────────────────────────────────────────────────
function damaged() {
  return {
    sessionDate: SAT,
    attendance: {
      // Friday: End of the day was pressed before midnight for some players.
      [FRI]: { entries: { p0: entry('p0', 'Thomas', true), p1: entry('p1', 'Aiden', false) }, payments: { tier: '3h', generatedAt: 1 } },
      // Saturday: the ghost. p1 paid at 12:40am; p9 was only ever recorded here.
      [SAT]: { entries: { p1: entry('p1', 'Aiden', true), p9: entry('p9', 'Wei', true) }, payments: { tier: '3h', generatedAt: 2 }, updatedAt: 99 },
      // Sunday + Monday: healthy game nights, must not be touched.
      [SUN]: { entries: { p0: entry('p0', 'Thomas', true) } },
      [MON]: { entries: { p0: entry('p0', 'Thomas', false) } },
      // Tuesday: a Monday night that bled past midnight.
      [TUE]: { entries: { p2: entry('p2', 'Sam', true) } },
    },
    sessions: {
      [SAT]: { players: [], rounds: [], numCourts: 2 },        // junk the rollover made
      [TUE]: { players: [], rounds: [], numCourts: 2 },
    },
  };
}

// ── 1. the plan ──────────────────────────────────────────────────────
{
  const plan = planNightMerge(damaged());
  eq('two ghost dates found', plan.strayDates.length, 2);
  check('Saturday is a ghost', plan.strayDates.includes(SAT));
  check('Tuesday is a ghost', plan.strayDates.includes(TUE));
  check('Friday is NOT a ghost', !plan.strayDates.includes(FRI));
  check('Sunday is NOT a ghost', !plan.strayDates.includes(SUN));
  check('Monday is NOT a ghost', !plan.strayDates.includes(MON));

  const sat = plan.merges.find((m) => m.from === SAT);
  eq('Saturday folds into Friday', sat && sat.to, FRI);
  const aiden = sat.entries.find((e) => e.playerId === 'p1');
  eq('Aiden\'s after-midnight payment is adopted', aiden && aiden.action, 'adopt-paid');
  const wei = sat.entries.find((e) => e.playerId === 'p9');
  eq('Wei, only ever on the ghost, is moved', wei && wei.action, 'move');

  const tue = plan.merges.find((m) => m.from === TUE);
  eq('Tuesday folds into Monday', tue && tue.to, MON);

  eq('both junk snapshots are dropped', plan.drops.length, 2);
  eq('no warnings on a clean case', plan.warnings.length, 0);

  // Purity: planning must not touch the state it was handed.
  const before = damaged(), snapshot = JSON.stringify(before);
  planNightMerge(before);
  eq('planNightMerge is pure', JSON.stringify(before), snapshot);
}

// ── 2. applying it ───────────────────────────────────────────────────
{
  const state = damaged();
  const plan = planNightMerge(state);
  const summary = applyNightMerge(state, plan);

  check('the Saturday record is gone', !state.attendance[SAT]);
  check('the Tuesday record is gone', !state.attendance[TUE]);
  check('Friday survives', !!state.attendance[FRI]);
  check('Sunday untouched', !!state.attendance[SUN]);

  const fri = state.attendance[FRI].entries;
  eq('Friday now has three players', Object.keys(fri).length, 3);
  eq('Aiden is now paid on Friday', fri.p1.paid, true);
  eq('Aiden keeps the real payment record', fri.p1.payment.method, 'cash');
  eq('Wei moved onto Friday', fri.p9.name, 'Wei');
  eq('Thomas is unchanged', fri.p0.paid, true);

  const mon = state.attendance[MON].entries;
  eq('Sam moved onto Monday', mon.p2 && mon.p2.name, 'Sam');
  eq('Monday\'s own player is untouched', mon.p0.paid, false);

  check('junk session snapshots removed', !state.sessions[SAT] && !state.sessions[TUE]);
  eq('summary counts the moves', summary.movedEntries, 2);
  eq('summary counts the adopted payments', summary.adoptedPayments, 1);
  eq('summary counts the dropped snapshots', summary.droppedSnapshots, 2);

  // ── 3. idempotent ──────────────────────────────────────────────────
  const again = planNightMerge(state);
  eq('re-planning after a merge finds nothing', again.merges.length, 0);
  eq('re-planning finds no ghosts', again.strayDates.length, 0);
  const s2 = JSON.stringify(state);
  applyNightMerge(state, again);
  eq('re-applying changes nothing', JSON.stringify(state), s2);
}

// ── 4. money is never lost or double-counted ─────────────────────────
{
  const state = damaged();
  const paidBefore = new Set();
  for (const d of Object.keys(state.attendance)) {
    for (const [pid, e] of Object.entries(state.attendance[d].entries)) if (e.paid) paidBefore.add(d + '|' + pid);
  }
  applyNightMerge(state, planNightMerge(state));
  let paidAfter = 0;
  for (const d of Object.keys(state.attendance)) {
    for (const e of Object.values(state.attendance[d].entries)) if (e.paid) paidAfter++;
  }
  // 5 paid records before (Fri p0, Sat p1, Sat p9, Sun p0, Tue p2); after the
  // merge Sat p1 lands on Fri p1, so the count holds at 5 — nothing vanished.
  eq('every paid record survives the merge', paidAfter, paidBefore.size);
}

// ── 5. a real off-day game is flagged, not silently eaten ────────────
{
  const state = damaged();
  state.sessions[SAT] = { players: [{ id: 'p0', name: 'Thomas' }], rounds: [{ label: 'Round 1', courts: [] }], numCourts: 1 };
  const plan = planNightMerge(state);
  check('a Saturday with real rounds raises a warning', plan.warnings.some((w) => w.includes(SAT) && w.includes('round')));
  check('and its snapshot is NOT dropped', !plan.drops.some((d) => d.date === SAT));
  applyNightMerge(state, plan);
  check('the flagged snapshot survives for review', !!state.sessions[SAT]);
}

// ── 6. the live session date is a casualty too ───────────────────────
// The midnight cron parked sessionDate on whatever day it last fired on, so in
// production it is usually sitting on an off day. If the merge deleted that
// day's attendance without moving the date, the live day would lose its records.
{
  const state = damaged();               // sessionDate is the ghost Saturday
  const plan = planNightMerge(state);
  eq('a stray session date is spotted', plan.sessionDate && plan.sessionDate.from, SAT);
  eq('and points back at its night', plan.sessionDate && plan.sessionDate.to, FRI);
  const summary = applyNightMerge(state, plan);
  eq('the live session date moves to the night', state.sessionDate, FRI);
  eq('and is reported', summary.sessionDate, SAT + ' → ' + FRI);
  check('the live day still has its attendance', !!state.attendance[FRI]);
  eq('nothing was orphaned', Object.keys(state.attendance[FRI].entries).length, 3);

  // A session date already on a game night is left exactly where it is.
  const healthy = damaged();
  healthy.sessionDate = SUN;
  const p2 = planNightMerge(healthy);
  eq('a healthy session date is not touched', p2.sessionDate, null);
  applyNightMerge(healthy, p2);
  eq('and survives the merge', healthy.sessionDate, SUN);
}

// ── 7. defensive ─────────────────────────────────────────────────────
{
  eq('empty state plans nothing', planNightMerge({}).merges.length, 0);
  eq('null state plans nothing', planNightMerge(null).merges.length, 0);
  eq('state with no attendance plans nothing', planNightMerge({ sessions: {} }).merges.length, 0);
  // A ghost whose night has no record at all: the whole day relocates.
  const orphan = { attendance: { [SAT]: { entries: { p0: entry('p0', 'Thomas', true) } } }, sessions: {} };
  const plan = planNightMerge(orphan);
  eq('orphan ghost still targets Friday', plan.merges[0].to, FRI);
  eq('orphan ghost reports the night has no record', plan.merges[0].targetExists, false);
  applyNightMerge(orphan, plan);
  eq('orphan ghost relocated to Friday', orphan.attendance[FRI].entries.p0.name, 'Thomas');
  check('orphan ghost date removed', !orphan.attendance[SAT]);
}

if (failures.length) {
  console.error('test-night-migrate.js FAILED (' + failures.length + '):');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('test-night-migrate.js passed');
