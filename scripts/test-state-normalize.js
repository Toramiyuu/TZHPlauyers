#!/usr/bin/env node
/* Tests for api/state.js normalizeDrawState — graceful migration of old saved
 * blobs to the 2026-06-28 draw-overhaul shape (luckyDraw.drawDate/results).
 *
 * Also pins the Shuttlecock removal (2026-09): the `monthlyDraw` ballot and its
 * `monthlyEligibility` cache are no longer normalized, created or served, but an
 * EXISTING blob is deliberately left untouched in Redis — the records go dormant
 * rather than being destroyed. They must simply never reach a client again. */
'use strict';
const { normalizeDrawState, publicProjection } = require('../api/state.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

// ── Old blob: luckyDraw has legacy lastWinner only ──
{
  const old = {
    luckyDraw: { entries: ['Alex', 'Sam'], lastWinner: { name: 'Alex', at: 1 }, history: [] },
  };
  const s = normalizeDrawState(old);
  check('luckyDraw.entries preserved', Array.isArray(s.luckyDraw.entries) && s.luckyDraw.entries.length === 2);
  check('luckyDraw.drawDate added (YYYY-MM-DD)', /^\d{4}-\d{2}-\d{2}$/.test(s.luckyDraw.drawDate));
  check('luckyDraw.results defaults to []', Array.isArray(s.luckyDraw.results) && s.luckyDraw.results.length === 0);
  check('luckyDraw.spin defaults to null', s.luckyDraw.spin === null);
  check('luckyDraw.history kept', Array.isArray(s.luckyDraw.history));
}

// ── Missing luckyDraw entirely -> created with new defaults ──
{
  const s = normalizeDrawState({});
  check('luckyDraw created', s.luckyDraw && Array.isArray(s.luckyDraw.results) && /^\d{4}-\d{2}-\d{2}$/.test(s.luckyDraw.drawDate));
  check('no monthlyDraw ballot is created any more', s.monthlyDraw === undefined);
}

// ── Tolerant of garbage (does not throw) ──
{
  let threw = false;
  try { normalizeDrawState({ luckyDraw: 'nope', monthlyDraw: { participants: 'nope' } }); } catch (e) { threw = true; }
  check('does not throw on malformed input', threw === false);
}

// ══ Shuttlecock removal: dormant, not destroyed ════════════════════════
const BALLOT = {
  month: '2026-09', rollSuppressedMonth: '',
  prizes: ['1 Tube of new G2 Shuttlecock'],
  participants: [{ id: 'a', name: 'Joo', phone: '012', tubes: 16, tokens: 4 }],
  results: [{ rank: 1, id: 'a', name: 'Joo', prize: 'Tube', at: 123 }],
  spin: null, history: [{ month: '2026-08', at: 99, winners: [{ rank: 1, name: 'Karine' }] }],
};
{
  const blob = { luckyDraw: { entries: [] }, monthlyDraw: JSON.parse(JSON.stringify(BALLOT)) };
  const s = normalizeDrawState(blob);
  check('an existing ballot is left byte-for-byte alone (dormant, recoverable)',
    JSON.stringify(s.monthlyDraw) === JSON.stringify(BALLOT));
  check('its participants are not re-derived', s.monthlyDraw.participants[0].tokens === 4 && s.monthlyDraw.participants[0].tubes === 16);
  check('its past winners survive in the blob', s.monthlyDraw.history[0].winners[0].name === 'Karine');
}

// ── ...but it never reaches a client again ──
{
  const state = {
    players: [], roster: [], sessionDate: '2026-09-13',
    monthlyDraw: JSON.parse(JSON.stringify(BALLOT)),
    monthlyEligibility: { month: '2026-09', players: [{ playerId: 'p1', name: 'Joo', eligible: true }] },
    attendance: { '2026-09-11': { entries: {} } },
    audit: [{ action: 'x' }],
  };
  const pub = publicProjection(state);
  check('public poll does NOT carry the ballot', pub.monthlyDraw === undefined);
  check('public poll does NOT carry the eligibility cache', pub.monthlyEligibility === undefined);
  check('public poll still strips attendance + audit', pub.attendance === undefined && pub.audit === undefined);
  check('publicProjection does not mutate the stored blob', state.monthlyDraw.results.length === 1 && state.monthlyEligibility !== undefined);
  check('unrelated state still rides the poll', pub.sessionDate === '2026-09-13' && Array.isArray(pub.roster));
}

console.log(`\nstate-normalize tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
