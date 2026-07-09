#!/usr/bin/env node
/*
 * test-lucky-paid.js — behavioural guard for the Lucky Draw "paid players"
 * picker with 2-day expiry (feature added 2026-07-08).
 *
 * Requirement (with the user): admins tick the current-session players who have
 * PAID; those players form the pool the draw picks from, and each paid entry
 * stays eligible until 2 days after its session date, then auto-drops:
 *   Monday game  → stays until Wednesday
 *   Friday game  → stays until Sunday
 *   Sunday game  → stays until Tuesday
 * i.e. kept while today <= sessionDate + 2, pruned once today passes it.
 *
 * paidEntryExpiry(forDate) and pruneExpiredPaid(paid, today) are pure helpers
 * exported from api/state.js; the server prunes on every GET via
 * normalizeDrawState so expired paid entries never resurface.
 *
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const path = require('path');
const mod = require(path.join(path.resolve(__dirname, '..'), 'api', 'state.js'));
const { paidEntryExpiry, pruneExpiredPaid, normalizeDrawState } = mod;

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

if (typeof paidEntryExpiry !== 'function' || typeof pruneExpiredPaid !== 'function') {
  failures.push('paidEntryExpiry / pruneExpiredPaid not exported from api/state.js');
} else {
  // 1. Expiry is sessionDate + 2 days (Mon→Wed, Fri→Sun, Sun→Tue).
  check('Mon 07-06 → Wed 07-08', paidEntryExpiry('2026-07-06') === '2026-07-08');
  check('Fri 07-10 → Sun 07-12', paidEntryExpiry('2026-07-10') === '2026-07-12');
  check('Sun 07-12 → Tue 07-14', paidEntryExpiry('2026-07-12') === '2026-07-14');

  const paid = [
    { id: 'p0', name: 'Thomas', forDate: '2026-07-06' },   // Mon → until Wed 08
    { id: 'p1', name: 'Desmond', forDate: '2026-07-08' },  // Wed → until Fri 10
  ];

  // 2. On the expiry day itself, the entry is still kept (inclusive).
  {
    const kept = pruneExpiredPaid(paid, '2026-07-08'); // Wed: Thomas' last day
    check('inclusive: Thomas kept on his expiry day (Wed)', kept.some(p => p.id === 'p0'));
    check('inclusive: Desmond still kept (expires Fri)', kept.some(p => p.id === 'p1'));
  }

  // 3. The day AFTER expiry, the entry is pruned.
  {
    const kept = pruneExpiredPaid(paid, '2026-07-09'); // Thu: past Thomas' Wed
    check('expired: Thomas dropped the day after (Thu)', !kept.some(p => p.id === 'p0'));
    check('expired: Desmond still kept (expires Fri)', kept.some(p => p.id === 'p1'));
  }

  // 4. Malformed / missing forDate is dropped; non-array → [].
  {
    const kept = pruneExpiredPaid([{ id: 'x', name: 'X' }, null, { id: 'y', forDate: '2026-07-08' }], '2026-07-07');
    check('malformed: entry without forDate dropped', !kept.some(p => p && p.id === 'x'));
    check('malformed: valid entry kept', kept.some(p => p && p.id === 'y'));
    check('non-array paid → []', Array.isArray(pruneExpiredPaid('nope', '2026-07-07')) && pruneExpiredPaid(undefined, '2026-07-07').length === 0);
  }

  // 5. normalizeDrawState guarantees a paid array and prunes expired entries.
  {
    const blob = { luckyDraw: { entries: [], paid: [{ id: 'old', name: 'Old', forDate: '2000-01-01' }] } };
    normalizeDrawState(blob);
    check('normalize: paid is an array', Array.isArray(blob.luckyDraw.paid));
    check('normalize: ancient paid entry pruned', blob.luckyDraw.paid.length === 0);
    const blob2 = { luckyDraw: {} };
    normalizeDrawState(blob2);
    check('normalize: missing paid defaults to []', Array.isArray(blob2.luckyDraw.paid) && blob2.luckyDraw.paid.length === 0);
  }
}

console.log('test-lucky-paid — paid-player picker with 2-day expiry\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  expiry = sessionDate + 2 (inclusive of the last day)');
  console.log('  PASS  prune drops entries past their window + malformed entries');
  console.log('  PASS  normalizeDrawState guarantees + prunes the paid array');
  console.log('\nRESULT: PASS — all lucky-paid assertions green.');
  process.exit(0);
}
