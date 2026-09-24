#!/usr/bin/env node
/*
 * test-coming-soon.js — guard for the viewer's "Coming soon" card.
 *
 * Between nights the hall screen built no court cards at all, so it sat blank
 * under a "Live" dot — which reads as broken rather than as "no game on". The
 * viewer now fills that gap with the next session: date, time, level, places
 * left, and a Join button.
 *
 * PURE helpers in public/monthly-draw.js (shared browser + Node):
 *   normalizeGameDay(g)                  — coerces a socialGames row; `level` and
 *       `capacity` are later additions, so old rows default to '' and 0.
 *   nextGameDate(games, fromISO)         — next ENABLED game day on/after fromISO.
 *   signupsOnDate(signups, iso)          — how many people hold a place that day.
 *   upcomingSession(games, signups, iso) — the whole card payload, COUNTS ONLY.
 *
 * The counts-only shape matters: `upcoming` rides the PUBLIC GET, so it must
 * never carry a sign-up's name or phone number.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const MD = require('../public/monthly-draw.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

// 2026-09-04 is a Friday. Mon 7th, Fri 11th, Sun 13th follow.
const FRI = '2026-09-04', SAT = '2026-09-05', SUN = '2026-09-06', MON = '2026-09-07';
const GAMES = [
  { id: 'sg-fri', day: 'Friday', weekday: 5, time: '9–11pm', level: 'All levels', capacity: 24, enabled: true },
  { id: 'sg-sun', day: 'Sunday', weekday: 0, time: '8–10pm', level: 'Intermediate', capacity: 16, enabled: true },
  { id: 'sg-mon', day: 'Monday', weekday: 1, time: '9–11pm', enabled: false },
];

// ── normalizeGameDay ──
const n1 = MD.normalizeGameDay(GAMES[0]);
check('normalizeGameDay keeps a full row intact',
  n1.day === 'Friday' && n1.weekday === 5 && n1.time === '9–11pm' && n1.level === 'All levels' && n1.capacity === 24 && n1.enabled === true);
const old = MD.normalizeGameDay({ id: 'x', day: 'Friday', weekday: 5, time: '9–11pm', enabled: true });
check('an old row with no level/capacity defaults to "" and 0', old.level === '' && old.capacity === 0);
check('capacity 0 means no cap, not a real zero', MD.normalizeGameDay({ capacity: 0 }).capacity === 0);
check('a negative or junk capacity coerces to 0 (no cap)',
  MD.normalizeGameDay({ capacity: -5 }).capacity === 0 && MD.normalizeGameDay({ capacity: 'abc' }).capacity === 0);
check('a fractional capacity floors', MD.normalizeGameDay({ capacity: 23.9 }).capacity === 23);
check('weekday is derived from the day name when absent', MD.normalizeGameDay({ day: 'Sunday' }).weekday === 0);
check('an unknown day gives weekday -1', MD.normalizeGameDay({ day: 'Blursday' }).weekday === -1);
check('normalizeGameDay survives junk input', MD.normalizeGameDay(null).enabled === false && MD.normalizeGameDay(undefined).capacity === 0);

// ── nextGameDate ──
check('a game day finds ITSELF — Friday daytime still points at Friday night',
  MD.nextGameDate(GAMES, FRI).date === FRI);
check('Saturday rolls forward to Sunday', MD.nextGameDate(GAMES, SAT).date === SUN);
check('Sunday finds itself', MD.nextGameDate(GAMES, SUN).date === SUN);
check('Monday is DISABLED, so Monday rolls on to Friday', MD.nextGameDate(GAMES, MON).date === '2026-09-11');
check('the matched game comes back with the date', MD.nextGameDate(GAMES, SAT).game.time === '8–10pm');
check('no enabled days at all gives null',
  MD.nextGameDate(GAMES.map(g => ({ ...g, enabled: false })), FRI) === null);
check('an empty / junk games list gives null',
  MD.nextGameDate([], FRI) === null && MD.nextGameDate(null, FRI) === null);
check('an invalid fromISO gives null', MD.nextGameDate(GAMES, 'not-a-date') === null);
check('nextGameDate crosses a month and a year boundary',
  MD.nextGameDate([{ day: 'Friday', weekday: 5, enabled: true }], '2026-12-29').date === '2027-01-01');

// ── signupsOnDate ──
const signups = [
  { id: 's1', name: 'Alice', phone: '0123', dates: [FRI, SUN] },
  { id: 's2', name: 'Bob', phone: '0124', dates: [FRI] },
  { id: 's3', name: 'Cara', phone: '0125', dates: ['2026-09-11'] },
  { id: 's4', name: 'Dan', phone: '0126', days: ['Friday'] },   // legacy row, no dates[]
];
check('counts only the people holding that exact date', MD.signupsOnDate(signups, FRI) === 2);
check('a different date counts separately', MD.signupsOnDate(signups, SUN) === 1);
check('a date nobody picked counts 0', MD.signupsOnDate(signups, SAT) === 0);
check('a legacy weekday-only signup is not counted', MD.signupsOnDate(signups, '2026-09-18') === 0);
check('junk signups count 0', MD.signupsOnDate(null, FRI) === 0 && MD.signupsOnDate([null, {}], FRI) === 0);

// ── upcomingSession ──
const up = MD.upcomingSession(GAMES, signups, FRI);
check('upcoming carries the date, day, time and level',
  up.date === FRI && up.day === 'Friday' && up.time === '9–11pm' && up.level === 'All levels');
check('slots left is capacity minus the people already holding the date',
  up.capacity === 24 && up.taken === 2 && up.slotsLeft === 22);
check('a session with places is not full', up.full === false);

const tight = [{ day: 'Friday', weekday: 5, time: '9pm', level: 'Open', capacity: 2, enabled: true }];
const full = MD.upcomingSession(tight, signups, FRI);
check('a session at capacity reports 0 left and full', full.slotsLeft === 0 && full.full === true);
const over = MD.upcomingSession([{ day: 'Friday', weekday: 5, capacity: 1, enabled: true }], signups, FRI);
check('over-subscription never goes negative', over.slotsLeft === 0 && over.full === true);

const uncapped = MD.upcomingSession([{ day: 'Friday', weekday: 5, time: '9pm', enabled: true }], signups, FRI);
check('no capacity set means slotsLeft null (the card says "Open"), never 0',
  uncapped.capacity === 0 && uncapped.slotsLeft === null && uncapped.full === false);
check('an uncapped session still reports how many signed up', uncapped.taken === 2);
check('upcomingSession is null when nothing is scheduled',
  MD.upcomingSession([], signups, FRI) === null && MD.upcomingSession(GAMES, signups, 'junk') === null);

// PRIVACY: `upcoming` rides the public GET. Counts only — no names, no phones.
const keys = Object.keys(up).sort().join(',');
check('upcoming exposes exactly the card fields and nothing else',
  keys === 'capacity,date,day,full,level,slotsLeft,taken,time');
const blob = JSON.stringify(MD.upcomingSession(GAMES, signups, FRI));
check('no sign-up name leaks into upcoming', !/Alice|Bob|Cara|Dan/.test(blob));
check('no phone number leaks into upcoming', !/012[3-6]/.test(blob));

// ── wiring ──
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'state.js'), 'utf8');
check('the public GET carries upcoming',
  /\.\.\.publicProjection\(current\), upcoming: MD\.upcomingSession\(/.test(api));
check('the locked screen carries it too', /locked: true[\s\S]{0,200}upcoming: MD\.upcomingSession\(/.test(api));
check('the default game days document the new fields',
  /id: 'sg-fri'[^}]*level: ''[^}]*capacity: 0/.test(api));

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
// The blank grid was only half the confusion: the header kept claiming "Live"
// with a pulsing dot, next to a session date that had already finished.
check('the "Live" pill is hidden while nothing is on',
  /livePill\.style\.display = nothingOn \? 'none' : ''/.test(html)
  && /id="viewerLive"/.test(html));
check('the finished session date is hidden while nothing is on',
  /dateEl\.style\.display = nothingOn \? 'none' : ''/.test(html));
check('the card repaints when upcoming changes', /up: state\.upcoming/.test(html));
check('the card offers the existing join flow', /class="vsoon-join" onclick="soonJoin\(\)"/.test(html));
check('joining from the modal hands over instead of stacking two backdrops',
  /function soonJoin\(\)[\s\S]{0,220}soonModal'\)\.classList\.contains\('open'\)\) closeSoonModal\(\);[\s\S]{0,60}openJoinModal\(\)/.test(html));

// ── the header button ──
// The card alone only appeared on an idle screen. "When's the next game?" gets
// asked mid-session too, so the button is always in the viewer header.
check('the viewer header carries a Coming soon button',
  /id="viewerSoonBtn" onclick="openSoonModal\(\)"/.test(html)
  && /<span class="vsb-lab">Coming soon<\/span>/.test(html));
check('the button shows the next session date', /id="viewerSoonDate"/.test(html)
  && /dateEl\.textContent = up \? soonShortDate\(up\.date\) : ''/.test(html));
check('the button is refreshed on every viewer render, outside the court sig guard',
  /renderSoonButton\(\);\s+\/\/ cheap/.test(html));
check('the modal reuses the SAME card as the idle screen',
  /body\.appendChild\(buildComingSoonCard\(\)\)/.test(html));
check('Escape closes the Coming soon modal, but join wins when both are open',
  /joinModal'\)\.classList\.contains\('open'\)\) \{ closeJoinModal\(\); return; \}[\s\S]{0,140}soonModal'\)\.classList\.contains\('open'\)\) closeSoonModal\(\)/.test(html));
check('the 3D arena Escape relay knows about the modal too',
  /isOpen\('soonModal'\)\)\s+\{ closeSoonModal\(\);/.test(html));

// ── the admin-triggered takeover ──
// The card as a fallback only covered "no schedule at all". Between sessions the
// hall screen usually still HAS last night's rounds (or a grid of TBDs), which
// reads as a live game — so the admin flips the whole viewer over by hand.
check('the admin Courts tab carries the hall-screen switch',
  /id="csoonBtn" onclick="toggleComingSoon\(\)"/.test(html)
  && /HALL SCREEN|Hall screen/.test(html));
check('the switch persists as state.comingSoon so every viewer follows',
  /apiPost\(\{ comingSoon: on \}\)/.test(html) && /state\.comingSoon = on/.test(html));
check('the switch is a toggle, not a one-way trip',
  /const on = !\(state && state\.comingSoon\)/.test(html)
  && /btn\.textContent = on \? 'Back to courts' : 'Show .Coming soon.'/.test(html));
check('the takeover replaces the court cards entirely',
  /const soonMode = !!state\.comingSoon;\s*\n\s*if \(soonMode\) \{\s*\n\s*container\.appendChild\(buildComingSoonCard\(\)\);\s*\n\s*\} else \{/.test(html));
check('the takeover also hides Up Next',
  /if \(state\.comingSoon\) \{ panel\.style\.display = 'none'; panel\.innerHTML = ''; return; \}/.test(html));
check('"Live" and the finished date go while the takeover is up',
  /const nothingOn = soonMode \|\| container\.firstElementChild\?\.classList\.contains\('vsoon'\)/.test(html));
check('the footer drops the court/player tally during the takeover',
  /if \(nothingOn\) \{\s*\n\s*stats\.textContent = 'Members Only';/.test(html));
check('the takeover repaints when the switch flips', /soon: !!state\.comingSoon/.test(html));
check('the zero-schedule fallback still stands',
  /if \(!container\.children\.length\) container\.appendChild\(buildComingSoonCard\(\)\)/.test(html));
check('the admin card stays in step with the 2s poll',
  /renderComingSoonCard\(\);\s*\n\}/.test(html));

// soonShortDate is pure — check it directly rather than by regex.
const shortFn = (() => {
  const m = /function soonShortDate\(iso\) \{[\s\S]*?\n\}/.exec(html);
  return m ? new Function(`${m[0]}; return soonShortDate;`)() : null;
})();
check('soonShortDate renders DD/MM/YY', shortFn && shortFn('2026-09-25') === '25/09/26');
check('soonShortDate is blank for junk', shortFn && shortFn('') === '' && shortFn(null) === '');
check('the card shows date, time, level and slots',
  /vsoon-date">\$\{escHtml\(formatDisplayDate\(up\.date\)\)\}/.test(html)
  && /vsoon-time">\$\{escHtml\(up\.time\)\}/.test(html)
  && /chip\('Level', up\.level/.test(html)
  && /chip\('Slots'/.test(html));
check('an uncapped session renders "Open" rather than a number', /chip\('Slots', 'Open', false\)/.test(html));
check('the admin editor reads back level + capacity',
  /\.sg-level'\)\.value\.trim\(\)/.test(html) && /\.sg-cap'\)\.value/.test(html)
  && /return \{ id, day, weekday, time, level, capacity, enabled \}/.test(html));
check('the admin editor renders the level + capacity inputs',
  /class="admin-form-input sg-level"/.test(html) && /class="admin-form-input sg-cap"/.test(html));

console.log(`coming soon: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
