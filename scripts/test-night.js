#!/usr/bin/env node
/*
 * test-night.js — behavioural guard for the night boundary (added 2026-09-16).
 *
 * Requirement (with the user): "Treat Friday and Saturday as Friday, as the
 * social game goes on until 12:30 so I would end the night on Saturday 12:30am.
 * And I might go home and sleep first and then work in the afternoon, so I need
 * the whole next day to tally up the payments." Same for Sunday -> Monday.
 *
 * So a night is owned by the day it STARTED. Midnight is not a boundary: the
 * current night is the most recent GAME DAY (Mon/Fri/Sun) whose start hour has
 * passed. The old 00:00 rollover cut a Friday night in half and invented a
 * Saturday session, which is where the phantom Saturday payments came from.
 *
 * The Sun -> Mon pair is the interesting one: Monday afternoon must still be
 * SUNDAY's night (there is money to tally), and only flips when Monday's own
 * session starts in the evening.
 *
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const Night = require(path.join(ROOT, 'public', 'night.js'));
const Payments = require(path.join(ROOT, 'public', 'payments.js'));
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };
const eq = (name, got, want) => check(name + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')', got === want);

// Malaysia is a fixed UTC+8, so an instant is just the local wall clock minus 8h.
function myt(iso, hour, minute) {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), (hour || 0) - 8, minute || 0);
}

// A real week: Fri 2026-09-18, Sat 19th, Sun 20th, Mon 21st, Tue 22nd ... Fri 25th.
const FRI = '2026-09-18', SAT = '2026-09-19', SUN = '2026-09-20',
      MON = '2026-09-21', TUE = '2026-09-22', WED = '2026-09-23',
      THU = '2026-09-24', FRI2 = '2026-09-25';

// ── 1. Game days are Mon/Fri/Sun only ────────────────────────────────
eq('Friday is a game day', Night.isGameDay(FRI), true);
eq('Sunday is a game day', Night.isGameDay(SUN), true);
eq('Monday is a game day', Night.isGameDay(MON), true);
check('Saturday is NOT a game day', !Night.isGameDay(SAT));
check('Tuesday is NOT a game day', !Night.isGameDay(TUE));
check('Wednesday is NOT a game day', !Night.isGameDay(WED));
check('Thursday is NOT a game day', !Night.isGameDay(THU));

// ── 2. currentNight: the table from the module header ────────────────
// Play runs 9pm-12(:30)am, so the handover is 20:00 — an hour before the first
// shuttle, and the longest possible tail for tallying the night before.
eq('Fri 21:00 -> Friday',        Night.currentNight(myt(FRI, 21, 0)), FRI);   // mid-game
eq('Sat 00:30 -> Friday',        Night.currentNight(myt(SAT, 0, 30)), FRI);   // the 12:30am end
eq('Sat 03:00 -> Friday',        Night.currentNight(myt(SAT, 3, 0)), FRI);
eq('Sat 12:00 -> Friday',        Night.currentNight(myt(SAT, 12, 0)), FRI);   // ending the night at noon
eq('Sat 15:00 -> Friday',        Night.currentNight(myt(SAT, 15, 0)), FRI);   // tallying after a sleep
eq('Sat 23:59 -> Friday',        Night.currentNight(myt(SAT, 23, 59)), FRI);
eq('Sun 12:00 -> Friday',        Night.currentNight(myt(SUN, 12, 0)), FRI);   // Sunday has not started yet
eq('Sun 19:59 -> Friday',        Night.currentNight(myt(SUN, 19, 59)), FRI);  // last minute of Friday's night
eq('Sun 21:00 -> Sunday',        Night.currentNight(myt(SUN, 21, 0)), SUN);
eq('Mon 00:30 -> Sunday',        Night.currentNight(myt(MON, 0, 30)), SUN);
eq('Mon 11:59 -> Sunday',        Night.currentNight(myt(MON, 11, 59)), SUN);  // THE Sun->Mon case
eq('Mon 15:00 -> Sunday',        Night.currentNight(myt(MON, 15, 0)), SUN);
eq('Mon 19:59 -> Sunday',        Night.currentNight(myt(MON, 19, 59)), SUN);  // latest a Sunday night can be closed
eq('Mon 20:00 -> Monday',        Night.currentNight(myt(MON, 20, 0)), MON);   // Monday's own session takes over
eq('Mon 23:59 -> Monday',        Night.currentNight(myt(MON, 23, 59)), MON);
eq('Tue 12:00 -> Monday',        Night.currentNight(myt(TUE, 12, 0)), MON);
eq('Thu 23:00 -> Monday',        Night.currentNight(myt(THU, 23, 0)), MON);
eq('Fri2 12:00 -> Monday',       Night.currentNight(myt(FRI2, 12, 0)), MON);  // still tallying Monday
eq('Fri2 21:00 -> Friday 25th',  Night.currentNight(myt(FRI2, 21, 0)), FRI2);

// The boundary itself is exact and does not drift.
eq('Fri 19:59 -> previous Monday', Night.currentNight(myt(FRI, 19, 59)), '2026-09-14');
eq('Fri 20:00 -> Friday',          Night.currentNight(myt(FRI, 20, 0)), FRI);
eq('the boundary is the configured start hour', Night.GAME_START_HOUR, 20);

// ── 3. A night NEVER lands on an off day ─────────────────────────────
for (let h = 0; h < 24; h++) {
  for (const d of [FRI, SAT, SUN, MON, TUE, WED, THU]) {
    const n = Night.currentNight(myt(d, h, 0));
    check('currentNight is always a game day (' + d + ' ' + h + ':00 -> ' + n + ')', Night.isGameDay(n));
  }
}

// ── 4. owningNight / isStrayDate: where ghost records fold back to ───
eq('Saturday record folds into Friday',  Night.owningNight(SAT), FRI);
eq('Tuesday record folds into Monday',   Night.owningNight(TUE), MON);
eq('Wednesday record folds into Monday', Night.owningNight(WED), MON);
eq('Thursday record folds into Monday',  Night.owningNight(THU), MON);
eq('a Friday record stays on Friday',    Night.owningNight(FRI), FRI);
eq('a Sunday record stays on Sunday',    Night.owningNight(SUN), SUN);
check('Saturday is a stray date', Night.isStrayDate(SAT));
check('Tuesday is a stray date', Night.isStrayDate(TUE));
check('Friday is NOT a stray date', !Night.isStrayDate(FRI));
check('Monday is NOT a stray date', !Night.isStrayDate(MON));

// ── 5. nextSessionDate: the sticky rollover ──────────────────────────
// The whole bug: at Sat 00:00 the old code advanced Friday -> Saturday.
eq('Sat 00:30 does NOT advance off Friday', Night.nextSessionDate(FRI, myt(SAT, 0, 30)), null);
eq('Sat 15:00 does NOT advance off Friday', Night.nextSessionDate(FRI, myt(SAT, 15, 0)), null);
eq('Sun 12:00 does NOT advance off Friday', Night.nextSessionDate(FRI, myt(SUN, 12, 0)), null);
eq('Sun 19:59 does NOT advance off Friday', Night.nextSessionDate(FRI, myt(SUN, 19, 59)), null);
eq('Sun 20:00 advances Friday -> Sunday',   Night.nextSessionDate(FRI, myt(SUN, 20, 0)), SUN);
eq('Mon 15:00 does NOT advance off Sunday', Night.nextSessionDate(SUN, myt(MON, 15, 0)), null);
eq('Mon 19:59 does NOT advance off Sunday', Night.nextSessionDate(SUN, myt(MON, 19, 59)), null);
eq('Mon 20:00 advances Sunday -> Monday',   Night.nextSessionDate(SUN, myt(MON, 20, 0)), MON);
eq('Thu 12:00 does NOT advance off Monday', Night.nextSessionDate(MON, myt(THU, 12, 0)), null);
eq('Fri2 20:00 advances Monday -> Friday',  Night.nextSessionDate(MON, myt(FRI2, 20, 0)), FRI2);
eq('never re-fires on the current night',   Night.nextSessionDate(SUN, myt(SUN, 22, 0)), null);
eq('never rewinds a future scheduled day',  Night.nextSessionDate(FRI2, myt(SUN, 20, 0)), null);
eq('missing sessionDate adopts the night',  Night.nextSessionDate(null, myt(SAT, 15, 0)), FRI);

// A rollover target is itself always a game day — the invariant that kills the ghost.
for (let h = 0; h < 24; h++) {
  for (const d of [FRI, SAT, SUN, MON, TUE, WED, THU]) {
    const t = Night.nextSessionDate('2026-09-01', myt(d, h, 0));
    check('rollover target is always a game day (' + d + ' ' + h + ':00 -> ' + t + ')', t && Night.isGameDay(t));
  }
}

// ── 6. canStartTonight: the manual "Start tonight" button ────────────
check('Sunday 16:00 on Friday\'s night can start tonight', Night.canStartTonight(FRI, myt(SUN, 16, 0)));
check('Monday 16:00 on Sunday\'s night can start tonight', Night.canStartTonight(SUN, myt(MON, 16, 0)));
check('Saturday 16:00 cannot (not a game day)', !Night.canStartTonight(FRI, myt(SAT, 16, 0)));
check('Sunday 20:00 cannot (cron already rolled it)', !Night.canStartTonight(SUN, myt(SUN, 20, 0)));
check('already on tonight cannot start again', !Night.canStartTonight(SUN, myt(SUN, 16, 0)));
check('a future scheduled session cannot start tonight', !Night.canStartTonight(FRI2, myt(SUN, 16, 0)));

// ── 7. month edge: a Friday night that runs into the 1st ─────────────
// Fri 2026-10-30 -> the night owns Sat 31 Oct AND Sun 1 Nov until 20:00.
// The user's call: that night's points belong to OCTOBER.
const OCT_FRI = '2026-10-30', OCT_SAT = '2026-10-31', NOV_SUN = '2026-11-01';
eq('Fri 30 Oct night owns Sat 31 Oct', Night.currentNight(myt(OCT_SAT, 12, 0)), OCT_FRI);
eq('Fri 30 Oct night owns Sun 1 Nov morning', Night.currentNight(myt(NOV_SUN, 12, 0)), OCT_FRI);
check('the night is still October at 1 Nov noon', Night.currentNight(myt(NOV_SUN, 12, 0)).slice(0, 7) === '2026-10');
eq('Sun 1 Nov 19:59 is still the October night', Night.currentNight(myt(NOV_SUN, 19, 59)), OCT_FRI);
eq('Sun 1 Nov 20:00 starts a November night', Night.currentNight(myt(NOV_SUN, 20, 0)), NOV_SUN);

// ── 7b. isPickableDate: which days a calendar strip lets you tap ─────
// Games are Mon/Fri/Sun, so every other night is dead weight on a date strip.
// The exception is a date that already holds something: an old off-day session
// or the night on screen must stay reachable, never locked behind a grey button.
check('Friday can be picked', Night.isPickableDate(FRI, false));
check('Sunday can be picked', Night.isPickableDate(SUN, false));
check('Monday can be picked', Night.isPickableDate(MON, false));
check('an empty Saturday cannot be picked', !Night.isPickableDate(SAT, false));
check('an empty Tuesday cannot be picked', !Night.isPickableDate(TUE, false));
check('an empty Wednesday cannot be picked', !Night.isPickableDate(WED, false));
check('an empty Thursday cannot be picked', !Night.isPickableDate(THU, false));
check('a Saturday that holds a session CAN be picked', Night.isPickableDate(SAT, true));
check('a Wednesday one-off game night stays reachable', Night.isPickableDate(WED, true));
check('a game day is pickable with or without a record', Night.isPickableDate(FRI, true));
check('garbage date is never pickable', !Night.isPickableDate('nonsense', true));

// ── 8. defensive ─────────────────────────────────────────────────────
eq('garbage date is not a game day', Night.isGameDay('nonsense'), false);
eq('garbage date has no owning night', Night.owningNight('nonsense'), null);
eq('garbage date is not stray', Night.isStrayDate('nonsense'), false);
eq('prevGameDay of Friday is Monday', Night.prevGameDay(FRI), '2026-09-14');
eq('nextGameDay of Friday is Sunday', Night.nextGameDay(FRI), SUN);
eq('localDate is the raw calendar day, not the night', Night.localDate(myt(SAT, 0, 30)), SAT);

// ── 9. Payments opens on the night that still owes money ─────────────
// The treasurer tallies the afternoon AFTER the night, so landing on "today"
// meant landing on an empty day with the real work one tap away.
{
  const rec = (paid) => ({ paid, payment: { fee: 25, tier: '3h', method: null, paidAt: paid ? 1 : null } });
  const att = {
    [FRI]: { entries: { p0: rec(false), p1: rec(true) } },  // Friday still owes
    [SUN]: { entries: { p0: rec(true), p1: rec(true) } },   // Sunday fully settled
  };
  eq('opens on the unpaid Friday even though Sunday is newer', Payments.nightToOpen(att, SUN), FRI);

  const settled = { [FRI]: { entries: { p0: rec(true) } }, [SUN]: { entries: { p0: rec(true) } } };
  eq('everything settled → falls back to the live night', Payments.nightToOpen(settled, MON), MON);

  const both = {
    [FRI]: { entries: { p0: rec(false) } },
    [SUN]: { entries: { p0: rec(false) } },
  };
  eq('two nights owing → the most recent one', Payments.nightToOpen(both, MON), SUN);

  eq('no records at all → the live night', Payments.nightToOpen({}, FRI), FRI);
  eq('no records and no live night → null', Payments.nightToOpen({}, null), null);
  eq('garbage attendance → the live night', Payments.nightToOpen(null, FRI), FRI);
  // A record with no payment block is not a payable night.
  eq('attendance without payment records is ignored',
    Payments.nightToOpen({ [FRI]: { entries: { p0: { paid: false } } } }, MON), MON);
}

// ── 10. the admin UI is actually wired to all of this ────────────────
check('index.html loads night.js', /<script src="\/night\.js">/.test(HTML));
check('night.js is loaded AFTER session-draw.js (it depends on the schedule)',
  HTML.indexOf('<script src="/night.js">') > HTML.indexOf('<script src="/session-draw.js">'));
check('Payments tab opens via nightToOpen, not the live date', /pmDate = Payments\.nightToOpen\(/.test(HTML));
check('"Start tonight" button exists', /id="startTonightBtn"/.test(HTML));
check('"Start tonight" is driven by canStartTonight', /Night\.canStartTonight\(/.test(HTML));
check('off-day notice element exists', /id="sessionOffDayWarn"/.test(HTML));
check('off-day notice is driven by isGameDay', /Night\.isGameDay\(date\)/.test(HTML));
check('night controls render from the session-date section', /renderNightControls\(date\)/.test(HTML));
// The 2s admin poll runs through this render — it must not stomp live edits.
// Date strips: the Session History one and the Payments one both grey out the
// off nights rather than open an empty panel on a Tuesday.
check('history strip greys out off nights', /Night\.isPickableDate\(iso, !!sessions\[iso\]/.test(HTML) && /btn\.disabled = !pickable/.test(HTML));
check('payments strip greys out off nights', /Night\.isPickableDate\(iso, has\.has\(iso\)/.test(HTML) && / disabled title="No games on /.test(HTML));
check('both strips still open a date that holds something', /iso === selectedCalDate\)/.test(HTML) && /iso === pmDate \|\| iso === live\)/.test(HTML));
check('an off night is styled as off, not invisible', /\.cal-strip-btn\.s-off\{/.test(HTML));
check('night controls use the no-op repaint guard', /setHtmlIfChanged\(btn/.test(HTML) && /setHtmlIfChanged\(warn/.test(HTML));

// ── 11. the cron actually fires on the night boundary ────────────────
{
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rollover = (vercel.crons || []).find((c) => c.path === '/api/cron-rollover');
  check('rollover cron exists', !!rollover);
  // 10:00 UTC = 20:00 MYT = Night.GAME_START_HOUR. Midnight (16:00 UTC) is the bug.
  eq('rollover cron fires at the night boundary, not midnight', rollover && rollover.schedule, '0 12 * * *');
  const utcHour = 24 + Night.GAME_START_HOUR - 8 - 24;
  eq('cron hour matches GAME_START_HOUR', rollover && rollover.schedule, '0 ' + utcHour + ' * * *');
}

if (failures.length) {
  console.error('test-night.js FAILED (' + failures.length + '):');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('test-night.js passed');
