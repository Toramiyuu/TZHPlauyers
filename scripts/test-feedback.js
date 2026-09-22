#!/usr/bin/env node
/* test-feedback — the pure session-feedback logic in public/feedback.js: the option
 * catalogue, settings coercion, submission sanitising (the record is self-built, never
 * spread from the body), the per-night tallies the admin tab reads, and retention.
 * The handler rules live in lib/feedback.js (test-feedback-handler.js). */
'use strict';
const FB = require('../public/feedback.js');
const WD = require('../public/weekly-draw.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── catalogue ──
check('four options a side', FB.GOOD_OPTIONS.length === 4 && FB.BAD_OPTIONS.length === 4);
check('every option has a stable id and a label', FB.GOOD_OPTIONS.concat(FB.BAD_OPTIONS)
  .every(o => o && typeof o.id === 'string' && o.id && typeof o.label === 'string' && o.label));
check('ids are unique across BOTH sides (they share one label map)',
  new Set(FB.GOOD_IDS.concat(FB.BAD_IDS)).size === 8);
check('the four gripes from the brief are present',
  eq(FB.BAD_IDS, ['same-partners', 'same-opponents', 'no-challenge', 'long-wait']));
check('labelOf resolves both sides, empty for junk',
  FB.labelOf('long-wait') === 'Waited too long between games' && FB.labelOf('level') && FB.labelOf('nope') === '');
check('isGoodId / isBadId do not cross over',
  FB.isGoodId('level') && !FB.isGoodId('long-wait') && FB.isBadId('long-wait') && !FB.isBadId('level'));
check('no emoji in any label (the design guard forbids them)',
  !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(FB.GOOD_OPTIONS.concat(FB.BAD_OPTIONS).map(o => o.label).join('')));

// ── settings ──
check('defaults: on, 5 points', eq(FB.settingsOf({}), { enabled: true, points: 5 }));
check('defaults survive a junk blob', eq(FB.settingsOf({ feedbackSettings: 'nope' }), { enabled: true, points: 5 }));
check('an explicit 0 is kept (feedback with no reward)', FB.settingsOf({ feedbackSettings: { points: 0 } }).points === 0);
check('out-of-range and fractional points fall back to the default',
  FB.settingsOf({ feedbackSettings: { points: 999 } }).points === 5
  && FB.settingsOf({ feedbackSettings: { points: -1 } }).points === 5
  && FB.settingsOf({ feedbackSettings: { points: 2.5 } }).points === 5);
check('enabled:false is respected; undefined means on', FB.settingsOf({ feedbackSettings: { enabled: false } }).enabled === false);
check('isPointsValue: whole 0..50 only',
  FB.isPointsValue(0) && FB.isPointsValue(50) && !FB.isPointsValue(51) && !FB.isPointsValue(-1)
  && !FB.isPointsValue(1.5) && !FB.isPointsValue(NaN));

// ── buildSubmission ──
const ctx = { nowMs: 1000, playerId: 'p1', name: 'Kelvin' };
{
  const r = FB.buildSubmission({ good: ['level'], bad: ['long-wait'] }, ctx, null);
  check('a plain submission is accepted', r.ok && r.record.playerId === 'p1' && r.record.name === 'Kelvin');
  check('timestamps: at and updatedAt both stamped on a first submission', r.record.at === 1000 && r.record.updatedAt === 1000);
  check('a first submission is not yet awarded', r.record.awarded === false);
}
check('unknown option ids are dropped, not stored',
  eq(FB.buildSubmission({ good: ['level', 'bogus', '__proto__'] }, ctx, null).record.good, ['level']));
check('an option from the WRONG side is dropped',
  eq(FB.buildSubmission({ good: ['long-wait'], bad: ['level'], goodNote: 'x' }, ctx, null).record, {
    playerId: 'p1', name: 'Kelvin', good: [], bad: [], goodNote: 'x', badNote: '', at: 1000, updatedAt: 1000, awarded: false, awardedPoints: 0,
  }));
check('duplicates collapse and order follows the catalogue, not the input',
  eq(FB.buildSubmission({ bad: ['long-wait', 'same-partners', 'long-wait'] }, ctx, null).record.bad,
    ['same-partners', 'long-wait']));
check('notes have their whitespace collapsed and are trimmed',
  FB.buildSubmission({ badNote: '  sat   out\n\nthree rounds  ' }, ctx, null).record.badNote === 'sat out three rounds');
check('an over-long note is cut to MAX_NOTE',
  FB.buildSubmission({ badNote: 'x'.repeat(900) }, ctx, null).record.badNote.length === FB.MAX_NOTE);
check('a wholly empty submission is refused', (() => {
  const r = FB.buildSubmission({ good: [], bad: [], goodNote: '   ', badNote: '' }, ctx, null);
  return !r.ok && /at least one/i.test(r.error);
})());
check('a note alone is enough', FB.buildSubmission({ badNote: 'too much waiting' }, ctx, null).ok);
check('junk/missing body is refused, never thrown',
  !FB.buildSubmission(null, ctx, null).ok && !FB.buildSubmission({ good: 'level' }, ctx, null).ok);
check('the record is SELF-BUILT — extra body keys never reach it', (() => {
  const r = FB.buildSubmission({ good: ['level'], awarded: true, playerId: 'someone-else', points: 9999, admin: 1 }, ctx, null);
  return r.record.awarded === false && r.record.playerId === 'p1' && r.record.points === undefined && r.record.admin === undefined;
})());
check('an edit keeps the original `at`, moves updatedAt, and carries `awarded` forward', (() => {
  const prev = { at: 10, updatedAt: 10, awarded: true, awardedPoints: 5 };
  const r = FB.buildSubmission({ good: ['variety'] }, { nowMs: 99, playerId: 'p1', name: 'Kelvin' }, prev);
  return r.record.at === 10 && r.record.updatedAt === 99 && r.record.awarded === true;
})());
check('what was actually credited is carried forward, so a later rate change cannot rewrite history', (() => {
  const prev = { at: 10, awarded: true, awardedPoints: 5 };
  return FB.buildSubmission({ good: ['variety'] }, { nowMs: 99, playerId: 'p1', name: 'K' }, prev).record.awardedPoints === 5
    && FB.buildSubmission({ good: ['variety'] }, { nowMs: 99, playerId: 'p1', name: 'K' }, null).record.awardedPoints === 0
    && FB.buildSubmission({ good: ['variety'] }, { nowMs: 99, playerId: 'p1', name: 'K' }, { awardedPoints: 'junk' }).record.awardedPoints === 0;
})());
check('a long name is capped', FB.buildSubmission({ good: ['level'] }, { nowMs: 1, playerId: 'p', name: 'n'.repeat(200) }, null).record.name.length === 80);

// ── recordFor / hasContent ──
const state = { feedback: { '2026-09-18': { p1: { good: ['level'], bad: [], goodNote: '', badNote: '' }, p2: { good: [], bad: [], goodNote: '', badNote: '' } } } };
check('recordFor finds a record and returns null for anything missing',
  !!FB.recordFor(state, '2026-09-18', 'p1') && FB.recordFor(state, '2026-09-18', 'nope') === null
  && FB.recordFor(state, '2026-01-01', 'p1') === null && FB.recordFor({}, 'x', 'y') === null);
check('hasContent ignores an all-empty record', FB.hasContent(state.feedback['2026-09-18'].p1)
  && !FB.hasContent(state.feedback['2026-09-18'].p2) && !FB.hasContent(null));

// ── summarizeNight ──
{
  const day = {
    p1: { good: ['level', 'variety'], bad: ['long-wait'], goodNote: '', badNote: 'three rounds off', at: 5, updatedAt: 5, name: 'stale name' },
    p2: { good: ['level'], bad: [], goodNote: 'good night', badNote: '', at: 1, updatedAt: 9 },
    p3: { good: [], bad: [], goodNote: '', badNote: '' },   // empty: must not count
  };
  const s = FB.summarizeNight(day, { p1: 'Kelvin' });
  check('empty records are excluded from the count', s.count === 2);
  check('tallies count each option once per player', s.good.level === 2 && s.good.variety === 1 && s.bad['long-wait'] === 1);
  check('every catalogue id is present in the tally, zeroed when unused', s.bad['same-partners'] === 0 && Object.keys(s.good).length === 4);
  check('totals are the sum of the marks', s.goodTotal === 3 && s.badTotal === 1);
  check('the roster name wins over the one stored on the record', s.rows.find(r => r.playerId === 'p1').name === 'Kelvin');
  check('a player with no roster entry falls back to the record name, then the id',
    FB.summarizeNight({ px: { good: ['level'], name: 'Guest' } }, {}).rows[0].name === 'Guest'
    && FB.summarizeNight({ py: { good: ['level'] } }, {}).rows[0].name === 'py');
  check('rows are newest-updated first', s.rows[0].playerId === 'p2');
  check('an edited row is flagged', s.rows.find(r => r.playerId === 'p2').edited === true
    && s.rows.find(r => r.playerId === 'p1').edited === false);
  check('summarize survives junk', FB.summarizeNight(null, null).count === 0 && FB.summarizeNight('x').count === 0);
}

// ── nightsWithFeedback / countFor ──
{
  const s = { feedback: { '2026-09-18': { p1: { good: ['level'] } }, '2026-09-21': { p2: { good: [], bad: [], goodNote: '', badNote: '' } }, 'junk': { p3: { good: ['level'] } } } };
  check('only nights with real content are listed, newest first', eq(FB.nightsWithFeedback(s), ['2026-09-18']));
  check('countFor counts real rows only', FB.countFor(s, '2026-09-18') === 1 && FB.countFor(s, '2026-09-21') === 0 && FB.countFor(s, 'nope') === 0);
  check('nightsWithFeedback on an empty/junk state is []', eq(FB.nightsWithFeedback({}), []) && eq(FB.nightsWithFeedback(null), []));
}

// ── pruneFeedback ──
{
  const today = '2026-09-22';
  const old = WD.addDaysISO(today, -(FB.RETENTION_DAYS + 1));
  const edge = WD.addDaysISO(today, -FB.RETENTION_DAYS);
  const s = { feedback: { [old]: { p1: { good: ['level'] } }, [edge]: { p1: { good: ['level'] } }, [today]: { p1: { good: ['level'] } } } };
  FB.pruneFeedback(s, today, WD.addDaysISO);
  check('nights past the retention window are dropped', !s.feedback[old]);
  check('the boundary night and recent nights are kept', !!s.feedback[edge] && !!s.feedback[today]);
  check('prune is a no-op without a valid date or helper', (() => {
    const t = { feedback: { [old]: {} } };
    FB.pruneFeedback(t, 'nope', WD.addDaysISO); FB.pruneFeedback(t, today, null);
    return !!t.feedback[old];
  })());
  check('prune survives a state with no feedback at all', FB.pruneFeedback({}, today, WD.addDaysISO) && FB.pruneFeedback(null, today, WD.addDaysISO) === null);
  check('retention matches the attendance window', FB.RETENTION_DAYS === 100);
}

console.log('\nfeedback (pure): ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
