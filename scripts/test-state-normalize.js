#!/usr/bin/env node
/* Tests for api/state.js normalizeDrawState — graceful migration of old saved blobs
 * to the 2026-06-28 draw-overhaul shape (luckyDraw.drawDate/results, monthlyDraw.month,
 * rollSuppressedMonth, participant tubes/tokens). */
'use strict';
const { normalizeDrawState } = require('../api/state.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

// ── Old blob: luckyDraw has legacy lastWinner only; monthlyDraw participants have tokens, no tubes ──
{
  const old = {
    luckyDraw: { entries: ['Alex', 'Sam'], lastWinner: { name: 'Alex', at: 1 }, history: [] },
    monthlyDraw: {
      prizes: ['Prize A'],
      participants: [{ id: 'a', name: 'Joo', phone: '012', tokens: 4 }],
      results: [], spin: null, history: [],
    },
  };
  const s = normalizeDrawState(old);
  check('luckyDraw.entries preserved', Array.isArray(s.luckyDraw.entries) && s.luckyDraw.entries.length === 2);
  check('luckyDraw.drawDate added (YYYY-MM-DD)', /^\d{4}-\d{2}-\d{2}$/.test(s.luckyDraw.drawDate));
  check('luckyDraw.results defaults to []', Array.isArray(s.luckyDraw.results) && s.luckyDraw.results.length === 0);
  check('luckyDraw.spin defaults to null', s.luckyDraw.spin === null);
  check('luckyDraw.history kept', Array.isArray(s.luckyDraw.history));
  check('monthlyDraw.month added ("")', s.monthlyDraw.month === '');
  check('monthlyDraw.rollSuppressedMonth added ("")', s.monthlyDraw.rollSuppressedMonth === '');
  check('participant tubes derived from tokens*4 (4 -> 16)', s.monthlyDraw.participants[0].tubes === 16);
  check('participant tokens kept consistent (16/4 -> 4)', s.monthlyDraw.participants[0].tokens === 4);
  check('participant id/name/phone preserved', s.monthlyDraw.participants[0].id === 'a' && s.monthlyDraw.participants[0].name === 'Joo' && s.monthlyDraw.participants[0].phone === '012');
}

// ── Participant already has tubes (new shape) -> tubes preserved, tokens derived ──
{
  const s = normalizeDrawState({ monthlyDraw: { participants: [{ id: 'h', name: 'Harvey', tubes: 6 }] } });
  check('tubes=6 preserved', s.monthlyDraw.participants[0].tubes === 6);
  check('tokens derived 6/4 -> 1', s.monthlyDraw.participants[0].tokens === 1);
}

// ── Missing luckyDraw / monthlyDraw entirely -> created with new defaults ──
{
  const s = normalizeDrawState({});
  check('luckyDraw created', s.luckyDraw && Array.isArray(s.luckyDraw.results) && /^\d{4}-\d{2}-\d{2}$/.test(s.luckyDraw.drawDate));
  check('monthlyDraw created with month + rollSuppressedMonth', s.monthlyDraw && s.monthlyDraw.month === '' && s.monthlyDraw.rollSuppressedMonth === '' && Array.isArray(s.monthlyDraw.participants));
}

// ── Existing month value is preserved (not clobbered) ──
{
  const s = normalizeDrawState({ monthlyDraw: { month: '2026-05', rollSuppressedMonth: '2026-04', participants: [] } });
  check('existing month preserved', s.monthlyDraw.month === '2026-05');
  check('existing rollSuppressedMonth preserved', s.monthlyDraw.rollSuppressedMonth === '2026-04');
}

// ── Tolerant of garbage (does not throw) ──
{
  let threw = false;
  try { normalizeDrawState({ luckyDraw: 'nope', monthlyDraw: { participants: 'nope' } }); } catch (e) { threw = true; }
  check('does not throw on malformed input', threw === false);
}

console.log(`\nstate-normalize tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
