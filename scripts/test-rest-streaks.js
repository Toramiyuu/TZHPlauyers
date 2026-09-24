#!/usr/bin/env node
/*
 * test-rest-streaks.js — behavioural guard for the admin "bench watch".
 *
 * WHAT CHANGED. The bench used to count ROUNDS sat out:
 *
 *   computeRestStreaks(rounds, players, uptoRound) -> consecutive rounds benched
 *   restHeatLevel(streak)                          -> redness, red from 2 rounds
 *
 * Both are gone. A round was one row of every court playing at once, and once
 * the courts stopped moving in step that number stopped describing anything:
 * sitting out one twenty-minute deuce game counted the same as sitting out two
 * eight-minute ones, and the person who had genuinely waited longest was not
 * the person at the top of the bench.
 *
 * Waiting is real minutes now, off the record of finished games:
 *
 *   waitMinutes(played, players, liveIds, now) -> { id: whole minutes waiting }
 *   waitHeatLevel(minutes) / waitBandLabel(level)
 *
 * The arithmetic itself is covered in scripts/test-game-queue.js. What THIS
 * file guards is that the bench, the slot picker and the auto-fill all read
 * that one number — three places that used to share computeRestStreaks and
 * would otherwise be free to drift apart and rank the same two people
 * differently on the same screen.
 *
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(path.resolve(__dirname, '..'), 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

function extractFn(name, src) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start === -1) return null;
  const braceOpen = src.indexOf('{', start);
  if (braceOpen === -1) return null;
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

// ── the round-counting helpers must stay deleted ──
// They are the whole bug this change exists to fix. If either comes back,
// something is ranking the bench by rounds again.
for (const dead of ['computeRestStreaks', 'restHeatLevel']) {
  check(`${dead}() stays deleted`, extractFn(dead, html) === null);
}

// ── the three readers all go through waitMinutes ──
// Named individually rather than counted, so a failure says WHICH screen has
// drifted rather than just that the total moved.
const READERS = [
  ['renderRestingPlayers', 'the bench'],
  ['openCourtSlotPicker', 'the court slot picker'],
  ['autoFillCandidates', 'the auto-fill ranking'],
  ['openPlayerPicker', 'the queue player picker'],
];
for (const [fn, what] of READERS) {
  const src = extractFn(fn, html);
  if (!src) { failures.push(`${fn}() not found in public/index.html`); continue; }
  check(`${what} measures waiting with waitMinutes`, /waitMinutes\s*\(/.test(src));
  // Nobody may reach for a round index to decide who has waited longest.
  check(`${what} does not rank by rounds`, !/computeRestStreaks|uptoRound/.test(src));
}

// ── the bench shows minutes, and says so ──
{
  const src = extractFn('renderRestingPlayers', html) || '';
  check('the bench groups by the redness band', /waitHeatLevel\s*\(/.test(src));
  check('the bench labels each band', /waitBandLabel\s*\(/.test(src));
  // "3 ROUNDS" was the old caps label. A stale one would be a lie about a
  // number that is now minutes.
  check('no ROUNDS label survives on the bench', !/ROUND\$\{|ROUNDS?'/.test(src));
  // Somebody who has not played at all is measured from the start of the night,
  // which ranks them correctly but must not be shown as though they had a game.
  check('somebody who has not played yet is said to have not played',
    /hasn't had a game yet|NOT PLAYED YET/.test(src));
}

// ── the picker badge is minutes, not a round count ──
{
  const src = extractFn('renderPslotRows', html) || html;
  check('the picker badge reads in minutes', /Waiting \$\{x\.n\}m/.test(src));
  check('the old "Sat out N" badge is gone', !/badge: `Sat out/.test(html));
}

// ── waiting never counts somebody who is on a court ──
// The one rule that stops the bench offering a game to a player who is
// visibly mid-rally. Checked against the real helper rather than the source.
{
  const srcs = ['gameIds', 'waitMinutes'].map(n => extractFn(n, html));
  if (srcs.some(s => !s)) failures.push('waitMinutes()/gameIds() not found in public/index.html');
  else {
    const waitMinutes = new Function(`${srcs.join('\n')}; return waitMinutes;`)();
    const NOW = 3600000;
    const played = [{ team1: ['a', 'b'], team2: ['c', 'd'], startedAt: NOW - 1800000, endedAt: NOW - 600000 }];
    const w = waitMinutes(played, [{ id: 'a' }, { id: 'b' }], new Set(['b']), NOW);
    check('somebody off court is counted from when their game ended', w.a === 10);
    check('somebody on court is not waiting at all', w.b === 0);
  }
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-rest-streaks — the bench measures waiting in minutes\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  the round-counting helpers stay deleted');
  console.log('  PASS  bench, slot picker, auto-fill and queue picker all read waitMinutes');
  console.log('  PASS  the bench groups and labels by minutes, not rounds');
  console.log('  PASS  a player on a court is never counted as waiting');
  console.log('\nRESULT: PASS — all bench-watch assertions green.');
  process.exit(0);
}
