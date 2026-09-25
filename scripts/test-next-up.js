#!/usr/bin/env node
/*
 * test-next-up.js — guard for the viewer's "Up Next" panel.
 *
 * WHAT CHANGED, twice, and why this file keeps being rewritten.
 *
 * Up Next began as "for each court, the round after the one it is on":
 * computeNextUp(rounds, courtRounds, numCourts) -> one row per court, backed by
 * computeNextUp, nextCourtRounds and applyNextUpEdits. All three are gone with
 * the round model, and they must stay gone: they advanced a court on a shared
 * round number, which stopped being true the moment two courts diverged.
 *
 * It then showed the front of ONE shared queue with no court against it, because
 * a queued game had no court until a court freed up.
 *
 * Now the queue is one lane per court, so a queued game DOES know its court from
 * the moment it is planned, and the panel is a column per court:
 *
 *   computeUpNext(queue, limit, courtIdx)        -> one lane's next games
 *   computeUpNextByCourt(queue, numCourts, lim)  -> [{ court, games }] per court
 *
 * The important property is unchanged: this is a READ. Which game a court takes,
 * and what happens to the one that finished, lives in test-game-queue.js.
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

// computeUpNext reads a lane, so laneOf/queueCourtOf load with it.
const NAMES = ['queueCourtOf', 'laneOf', 'computeUpNext', 'computeUpNextByCourt'];
const srcs = NAMES.map(n => {
  const s = extractFn(n, html);
  if (!s) { console.error(`FAIL: ${n}() not found in public/index.html`); process.exit(1); }
  return s;
});
const { computeUpNext, computeUpNextByCourt } =
  new Function(`${srcs.join('\n')}; return { ${NAMES.join(', ')} };`)();

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

// n = a handle, c = the court the game is planned for.
const g = (n, c) => ({ id: 'g' + n, court: c, team1: ['a' + n, 'b' + n], team2: ['c' + n, 'd' + n] });
// Deliberately interleaved: the lanes are NOT contiguous in the flat array, and
// reading them must not depend on them being so.
const queue = [g(1, 0), g(2, 1), g(3, 0), g(4, 1), g(5, 0), g(6, 2)];

// ── one lane ──
check('it shows the front of ONE court\'s lane, in order',
  computeUpNext(queue, 2, 0).map(x => x.id).join(',') === 'g1,g3');
check('another court gets its own games, not the array order',
  computeUpNext(queue, 2, 1).map(x => x.id).join(',') === 'g2,g4');
check('it stops at the limit', computeUpNext(queue, 2, 0).length === 2);
check('a lane shorter than the limit is shown whole', computeUpNext(queue, 9, 2).length === 1);
check('a court with nothing queued shows nothing', computeUpNext(queue, 4, 3).length === 0);
check('an empty queue shows nothing', computeUpNext([], 4, 0).length === 0);
check('a missing queue shows nothing', computeUpNext(null, 4, 0).length === 0);
check('no limit means the whole lane', computeUpNext(queue, 0, 0).length === 3);
check('junk for a limit means the whole lane', computeUpNext(queue, 'lots', 0).length === 3);
check('no court asked for means the whole queue (the admin badge count)',
  computeUpNext(queue, 0).length === 6);

// It must not hand out the live array: renderUpNext is called on every poll
// tick and anything mutating what it gets back would be editing the queue.
const copy = computeUpNext(queue, 0);
copy.push(g(99, 0));
check('it returns a copy, not the queue itself', queue.length === 6);

// ── every court at once ──
{
  const lanes = computeUpNextByCourt(queue, 4, 2);
  check('one entry per ACTIVE court, in court order',
    lanes.length === 4 && lanes.map(l => l.court).join(',') === '0,1,2,3');
  check('each entry carries that court\'s own next games',
    lanes[0].games.map(x => x.id).join(',') === 'g1,g3'
    && lanes[1].games.map(x => x.id).join(',') === 'g2,g4'
    && lanes[2].games.map(x => x.id).join(',') === 'g6');
  check('a court with nothing queued is kept, with an empty list',
    lanes[3].games.length === 0);
  check('a court that is switched off is not shown at all',
    computeUpNextByCourt(queue, 2, 2).length === 2);
  check('junk counts are safe',
    computeUpNextByCourt(queue, 0, 2).length === 0
    && computeUpNextByCourt(queue, 'two', 2).length === 0
    && computeUpNextByCourt(null, 2, 2).every(l => l.games.length === 0));
}

// A game saved before lanes existed has no court and belongs to the first one.
check('a pre-lane game shows up on court 1, not nowhere',
  computeUpNext([{ id: 'old', team1: ['a', 'b'], team2: ['c', 'd'] }], 4, 0).length === 1);

// The deleted helpers must stay deleted. Bringing any of them back means
// somebody has re-tied Up Next to a shared round number, which is the bug.
for (const dead of ['computeNextUp', 'nextCourtRounds', 'applyNextUpEdits']) {
  check(`${dead}() is gone for good`, extractFn(dead, html) === null);
}

// ── the panel itself ──
check('the viewer draws a column per court',
  /computeUpNextByCourt\(state\.queue, state\.numCourts \|\| 1, UPNEXT_SHOWN\)/.test(html)
  && html.includes('class="upnext-col"') && html.includes('upnext-colhead'));
check('each column is headed with the court number',
  /Court \$\{escHtml\(String\(courtLabel\(l\.court\)\)\)\}/.test(html));
check('a court with nothing queued says so rather than vanishing',
  html.includes('Nothing queued yet'));
check('the panel hides only when EVERY lane is empty',
  /if \(!lanes\.some\(l => l\.games\.length\)\)/.test(html));
check('the columns are a responsive grid, not a fixed row',
  /\.upnext-cols\{[^}]*grid-template-columns:repeat\(auto-fit/.test(html));

console.log('\ntest-next-up — the viewer Up Next panel, one column per court\n');
if (!failures.length) {
  console.log('  PASS  a lane is read in its own order, capped at the limit');
  console.log('  PASS  empty, short and junk inputs are safe');
  console.log('  PASS  every active court comes back, even with nothing queued');
  console.log('  PASS  it hands back a copy, and pre-lane games land on court 1');
  console.log('  PASS  the shared-round helpers stay deleted');
  console.log('  PASS  the panel renders a headed column per court');
  console.log('\nRESULT: PASS — Up Next assertions green.');
  process.exit(0);
}
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) red.`);
process.exit(1);
