#!/usr/bin/env node
/*
 * test-next-up.js — guard for the viewer's "Up Next" panel.
 *
 * WHAT CHANGED, and why this file is much smaller than it was.
 *
 * Up Next used to be "for each court, the round after the one it is on":
 * computeNextUp(rounds, courtRounds, numCourts) -> one row per court, and each
 * row on an admin device advanced that one court. Three helpers backed it —
 * computeNextUp, nextCourtRounds and applyNextUpEdits — and all three are gone,
 * along with the round model itself.
 *
 * They had to go because they promised something nobody can know. A game gets a
 * court at the moment a court frees up, and which court frees up first depends
 * on whether court 2's game goes to deuce. Telling the hall screen "Court 3 is
 * next for Harvey" was the round model showing through, and it was wrong in
 * exactly the situation the queue exists to handle.
 *
 * So the panel now shows the front of the shared queue, in order, with no court
 * against it:
 *
 *   computeUpNext(queue, limit) -> the first `limit` queued games
 *
 * The behaviour those three deleted helpers used to guard now lives in
 * scripts/test-game-queue.js: which game a court takes, what it skips and why,
 * and what happens to the game that just finished.
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

const srcFn = extractFn('computeUpNext', html);
if (!srcFn) { console.error('FAIL: computeUpNext() not found in public/index.html'); process.exit(1); }
const computeUpNext = new Function(`${srcFn}; return computeUpNext;`)();

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

const g = (n) => ({ id: 'g' + n, team1: ['a' + n, 'b' + n], team2: ['c' + n, 'd' + n] });
const queue = [g(1), g(2), g(3), g(4), g(5), g(6)];

check('it shows the front of the queue, in order',
  computeUpNext(queue, 3).map(x => x.id).join(',') === 'g1,g2,g3');
check('it stops at the limit', computeUpNext(queue, 4).length === 4);
check('a queue shorter than the limit is shown whole', computeUpNext([g(1)], 4).length === 1);
check('an empty queue shows nothing', computeUpNext([], 4).length === 0);
check('a missing queue shows nothing', computeUpNext(null, 4).length === 0);
check('no limit means the whole queue', computeUpNext(queue, 0).length === 6);
check('junk for a limit means the whole queue', computeUpNext(queue, 'lots').length === 6);

// It must not hand out the live array: renderUpNext is called on every poll
// tick and anything mutating what it gets back would be editing the queue.
const copy = computeUpNext(queue, 0);
copy.push(g(99));
check('it returns a copy, not the queue itself', queue.length === 6);

// The panel shows games, not courts. A queued game has no court, and if one
// ever appears here it means the round model has crept back in.
check('a queued game carries no court',
  computeUpNext(queue, 2).every(x => x.court === undefined));

// The deleted helpers must stay deleted. Bringing any of them back means
// somebody has re-tied a queued game to a specific court, which is the bug.
for (const dead of ['computeNextUp', 'nextCourtRounds', 'applyNextUpEdits']) {
  check(`${dead}() is gone for good`, extractFn(dead, html) === null);
}

console.log('\ntest-next-up — the viewer Up Next panel reads the shared queue\n');
if (!failures.length) {
  console.log('  PASS  the front of the queue, in order, capped at the limit');
  console.log('  PASS  empty, short and junk inputs are safe');
  console.log('  PASS  it hands back a copy, and the games carry no court');
  console.log('  PASS  the per-court round helpers stay deleted');
  console.log('\nRESULT: PASS — Up Next assertions green.');
  process.exit(0);
}
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) red.`);
process.exit(1);
