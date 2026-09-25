#!/usr/bin/env node
/*
 * test-court-cards.js — behavioural guard for the Courts cards + the live game
 * clock on both boards.
 *
 * The Courts tab's "Individual Court Control" cards are the Friendly board's
 * matchup pods applied to the session schedule: a court-number chip picker, a
 * status select (Live / Up Next / Final), the ending-soon clock, a lock that
 * survives a schedule regenerate, an × that drops the court, and — while the
 * court is Live — a clock showing how long the current game has been on. The
 * Friendly pods gained the same clock. All the non-DOM logic lives in pure
 * helpers inside public/index.html:
 *
 *   normalizeCourtStatus / setCourtStatusAt   per-court 'live'|'next'|'final'
 *   normalizeCourtLocks  / setCourtLockAt     per-court lock booleans
 *   normalizeCourtLive   / setCourtLiveAt     per-court game-start stamps (ms)
 *   takeNextGame / putGameBack                restart one court's clock
 *                                             whose round changed
 *   formatElapsed                             ms -> M:SS / H:MM:SS
 *   setCourtNumberAt                          pick a court number (swaps on clash)
 *   applyCourtDrop                            drop one court slot from the day
 *   (applyLockedFirstRound is gone: generating cannot touch a live court)
 *   liveClockHTML                             the shared clock chip markup
 *
 * Part 2 statically checks that both boards actually render the new controls.
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(path.resolve(__dirname, '..'), 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// ── extract a top-level function's source by brace matching ─────────
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
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

// These helpers call each other, so they are evaluated together in one scope
// alongside the COURT_STATUSES list they validate against.
const NAMES = [
  'normalizeCourtNumbers', 'normalizeEndingSoon',
  'normalizeCourtStatus', 'setCourtStatusAt',
  'normalizeCourtLocks', 'setCourtLockAt',
  'normalizeCourtLive', 'setCourtLiveAt',
  'formatElapsed', 'setCourtNumberAt', 'applyCourtDrop',
  'liveClockHTML',
];
const constSrc = (html.match(/const COURT_STATUSES = \[[^\]]*\];/) || [])[0];
if (!constSrc) failures.push('COURT_STATUSES is not defined in public/index.html');

let H = {};
{
  const parts = [];
  for (const n of NAMES) {
    const src = extractFn(n, html);
    if (!src) failures.push(`${n} is not defined in public/index.html`);
    else parts.push(src);
  }
  if (!failures.length) {
    // eslint-disable-next-line no-new-func
    H = new Function(`${constSrc}\n${parts.join('\n')}\nreturn {${NAMES.join(',')}};`)();
  }
}

if (H.normalizeCourtStatus) {

  // ── normalizeCourtStatus / setCourtStatusAt ─────────────────────
  {
    const { normalizeCourtStatus: norm, setCourtStatusAt: set } = H;
    // 1. Missing state reads as all-Live, so a pre-feature night is unchanged.
    {
      const a = norm(undefined, 3);
      check('normalizeCourtStatus: missing -> all live', a.length === 3 && a.every(v => v === 'live'));
      check('normalizeCourtStatus: non-array -> all live', norm('junk', 2).every(v => v === 'live'));
    }
    // 2. Pads, truncates and rejects unknown statuses.
    {
      const a = norm(['final'], 3);
      check('normalizeCourtStatus: pads to numCourts', a.length === 3 && a[0] === 'final' && a[1] === 'live' && a[2] === 'live');
      const b = norm(['next', 'final', 'next'], 2);
      check('normalizeCourtStatus: truncates to numCourts', b.length === 2 && b[1] === 'final');
      const c = norm(['LIVE', 3, null, 'done'], 4);
      check('normalizeCourtStatus: unknown values fall back to live', c.every(v => v === 'live'));
    }
    // 3. Zero / missing numCourts is an empty array, never a throw.
    {
      check('normalizeCourtStatus: zero courts -> []', norm(['live'], 0).length === 0);
      check('normalizeCourtStatus: missing numCourts -> []', norm(['live'], undefined).length === 0);
    }
    // 4. setCourtStatusAt writes one court and is pure.
    {
      const input = ['live', 'live'];
      const a = set(input, 1, 2, 'final');
      check('setCourtStatusAt: sets the named court', a[0] === 'live' && a[1] === 'final');
      check('setCourtStatusAt: does not mutate input', input[1] === 'live');
    }
    // 5. Out-of-range court and unknown status are both no-ops.
    {
      const a = set(['live', 'next'], 5, 2, 'final');
      check('setCourtStatusAt: out-of-range court is a no-op', a[0] === 'live' && a[1] === 'next');
      const b = set(['live', 'next'], 0, 2, 'paused');
      check('setCourtStatusAt: unknown status is a no-op', b[0] === 'live' && b[1] === 'next');
    }
  }

  // ── normalizeCourtLocks / setCourtLockAt ────────────────────────
  {
    const { normalizeCourtLocks: norm, setCourtLockAt: set } = H;
    {
      const a = norm([1, 0, 'x'], 4);
      check('normalizeCourtLocks: coerces to booleans + pads',
        a.length === 4 && a[0] === true && a[1] === false && a[2] === true && a[3] === false);
      check('normalizeCourtLocks: missing -> all false', norm(undefined, 2).every(v => v === false));
    }
    {
      const input = [false, false];
      const a = set(input, 0, 2);
      check('setCourtLockAt: toggles off->on', a[0] === true && a[1] === false);
      check('setCourtLockAt: toggles on->off', set(a, 0, 2)[0] === false);
      check('setCourtLockAt: explicit value wins', set([true, true], 1, 2, false)[1] === false);
      check('setCourtLockAt: does not mutate input', input[0] === false);
      check('setCourtLockAt: out-of-range is a no-op', set([false, false], 9, 2)[0] === false);
    }
  }

  // ── normalizeCourtLive / setCourtLiveAt ─────────────────────────
  {
    const { normalizeCourtLive: norm, setCourtLiveAt: set } = H;
    // 1. Only positive finite stamps survive; everything else is "no clock".
    {
      const a = norm([1700000000000, -5, 'x', null, 0], 5);
      check('normalizeCourtLive: keeps a real stamp', a[0] === 1700000000000);
      check('normalizeCourtLive: junk/negative/zero -> 0', a[1] === 0 && a[2] === 0 && a[3] === 0 && a[4] === 0);
      check('normalizeCourtLive: missing -> all 0', norm(undefined, 3).every(v => v === 0));
    }
    // 2. Fractional stamps are floored (whole milliseconds only).
    {
      check('normalizeCourtLive: floors fractional stamps', norm([1700000000000.9], 1)[0] === 1700000000000);
    }
    // 3. setCourtLiveAt starts and stops one court's clock, purely.
    {
      const input = [0, 0];
      const a = set(input, 1, 2, 1700000000000);
      check('setCourtLiveAt: starts the named court', a[0] === 0 && a[1] === 1700000000000);
      check('setCourtLiveAt: does not mutate input', input[1] === 0);
      check('setCourtLiveAt: 0 stops the clock', set(a, 1, 2, 0)[1] === 0);
      check('setCourtLiveAt: no stamp stops the clock', set(a, 1, 2)[1] === 0);
      check('setCourtLiveAt: out-of-range is a no-op', set([0, 5], 7, 2, 1)[1] === 5);
    }
  }

  // restampCourtLive is GONE. It took a whole array of round indices and
  // restarted the clock of every court whose index had moved, because an
  // all-courts advance could restart several at once. Nothing moves more than
  // one court now, so takeNextGame stamps the single court it touched and
  // putGameBack winds that one back. Asserted against the source further down.

  // applyLockedFirstRound is GONE. Generating used to replace round 1, which
  // WAS the live games, so a locked court's four had to be carried across by
  // hand. Generating now only fills the queue and cannot touch a court that is
  // playing, so the lock is honoured by construction.

  // ── liveClockHTML ───────────────────────────────────────────────
  {
    const { liveClockHTML: chip } = H;
    // 1. Only a Live court has a game clock at all.
    {
      check('liveClockHTML: Up Next has no clock', chip('next', Date.now(), 'go()') === '');
      check('liveClockHTML: Final has no clock', chip('final', Date.now(), 'go()') === '');
      check('liveClockHTML: a missing status counts as live', chip(undefined, 0, 'go()') !== '');
    }
    // 2. A running clock carries its stamp for the 1s ticker and reads elapsed.
    {
      const out = chip('live', Date.now() - 65000, 'go(1)');
      check('liveClockHTML: running clock is marked on', out.includes('mu-clock on'));
      check('liveClockHTML: running clock shows the elapsed time', out.includes('>1:05<'));
      check('liveClockHTML: running clock carries a stamp for the ticker',
        /data-live-since="\d{10,}"/.test(out));
      check('liveClockHTML: wires up the caller handler', out.includes('onclick="go(1)"'));
      // Tapping a RUNNING clock stops it, and that has to be visible without a
      // tooltip — a phone never shows one.
      check('liveClockHTML: a running clock says it stops on tap', out.includes('tap to stop the clock'));
      check('liveClockHTML: a running clock draws the stop square', out.includes('class="stop"'));
    }
    // 3. Live but never started offers to start, is not tickable, and shows no
    //    stop square (there is nothing running to stop).
    {
      const out = chip('live', 0, 'go()');
      check('liveClockHTML: unstarted clock offers Start', out.includes('>Start<'));
      check('liveClockHTML: unstarted clock is not marked on', !out.includes('mu-clock on'));
      check('liveClockHTML: unstarted clock has a zero stamp', out.includes('data-live-since="0"'));
      check('liveClockHTML: unstarted clock has no stop square', !out.includes('class="stop"'));
      check('liveClockHTML: unstarted clock says it starts on tap', out.includes('Start the clock'));
    }
    // 4. Junk stamps degrade to "not started" rather than a nonsense time.
    {
      check('liveClockHTML: junk stamp reads as unstarted', chip('live', 'x', 'go()').includes('>Start<'));
      check('liveClockHTML: negative stamp reads as unstarted', chip('live', -1, 'go()').includes('>Start<'));
    }
  }
}

// ── Part 2: both boards render the controls ─────────────────────────
{
  const courtsRender = (extractFn('renderCourtControls', html) || '');
  const friendlyRender = (extractFn('renderFriendlyMatchups', html) || '');
  const viewerCard = (extractFn('buildCourtCard', html) || '');

  // The Courts cards are the Friendly pods, so they must use the same shell.
  check('Courts cards use the Friendly matchup pod shell', courtsRender.includes('court-ctrl-card fr-matchup'));
  check('Courts cards keep the pod top bar', courtsRender.includes('fr-mu-top'));
  check('Courts cards have a court-number chip picker', courtsRender.includes('pickCourtNumber('));
  check('Courts cards have a status select', courtsRender.includes('setCourtStatus(') && courtsRender.includes('>Up Next<'));
  check('Courts cards keep the ending-soon clock button', courtsRender.includes('frb-es') && courtsRender.includes('toggleEndingSoon('));
  check('Courts cards have a lock', courtsRender.includes('frb-lock') && courtsRender.includes('toggleCourtLock('));
  check('Courts cards have a drop (x) button', courtsRender.includes('fr-mu-del') && courtsRender.includes('dropCourt('));
  check('Courts cards use the pod team rows', courtsRender.includes('frb-row red') && courtsRender.includes('frb-row blue'));
  // The round stepper is gone. A card takes its next game off the shared queue
  // and can put it back; it no longer walks a shared round index, because
  // moving a court that is still playing is the unfairness this replaced.
  check('Courts cards take the next game from the queue',
    courtsRender.includes('crt-next') && courtsRender.includes('nextGameOnCourt('));
  check('Courts cards can undo the game they just took', courtsRender.includes('undoCourtGame('));
  check('Courts cards no longer step through rounds',
    !courtsRender.includes('crt-rnav') && !courtsRender.includes('advanceCourt('));
  check('Courts cards show repeat-pairing warnings', courtsRender.includes('pairWarnHTML('));
  // "Layout only": the session board records no scores, so it must NOT grow the
  // Friendly score steppers or a Record button.
  check('Courts cards carry no score stepper', !courtsRender.includes('frb-score'));
  check('Courts cards carry no Record button', !courtsRender.includes('Record result'));
  check('Courts team rows drop the score column', courtsRender.includes('no-score'));

  // The live clock, on both boards.
  check('Courts cards render the live clock', courtsRender.includes('liveClockHTML(') && courtsRender.includes('toggleCourtClock('));
  check('Friendly pods render the live clock', friendlyRender.includes('liveClockHTML(') && friendlyRender.includes('toggleFriendlyClock('));
  // Stop/start is one tap on the chip: the handler must branch on whether the
  // clock is already running, on BOTH boards, and stopping must not touch the
  // court's status (a stopped clock is still a Live court).
  {
    const ct = extractFn('toggleCourtClock', html) || '';
    const fr = extractFn('toggleFriendlyClock', html) || '';
    check('a Courts clock tap stops a running clock', ct.includes('running ? 0 : Date.now()'));
    check('a Friendly clock tap stops a running clock', fr.includes('> 0 ? 0 : Date.now()'));
    check('stopping a Courts clock leaves the court Live', !ct.includes('courtStatus'));
    check('stopping a Friendly clock leaves the pod Live', !fr.includes('m.status'));
  }
  check('a 1s ticker updates the clocks between polls', html.includes('function tickLiveClocks()') && html.includes('startLiveClockTicker()'));
  check('the ticker only rewrites text, never markup', !(extractFn('tickLiveClocks', html) || '').includes('innerHTML'));
  check('setting a Friendly pod Live stamps its clock', html.includes('m.liveSince = m.status === \'live\' ? Date.now() : 0'));
  check('recording a Friendly result restarts the clock', (extractFn('recordFriendlyResult', html) || '').includes('m.liveSince = Date.now()'));

  // A new game on a court restarts that court's clock, and only that one.
  // restampCourtLive compared a whole round-index array because an all-courts
  // advance could restart several clocks at once; nothing moves more than one
  // court any more, so takeNextGame stamps the single court it touched.
  check('taking the next game restarts that court\'s clock',
    (extractFn('takeNextGame', html) || '').includes('setCourtLiveAt(s.courtLive, courtIdx'));
  check('undoing a game puts the clock back to when that game started',
    (extractFn('putGameBack', html) || '').includes('setCourtLiveAt(s.courtLive, courtIdx, numCourts, restoredAt)'));
  for (const dead of ['restampCourtLive', 'applyLockedFirstRound']) {
    check(`${dead}() stays deleted with the round model`, extractFn(dead, html) === null);
  }
  // Generating only fills ONE COURT'S queue now, so it cannot disturb a game in
  // progress at all — which is why locked courts need no special case in it.
  check('generating never touches a live clock',
    !(extractFn('generateLane', html) || '').includes('courtLive'));
  check('generating only writes the queue',
    (extractFn('generateLane', html) || '').includes('saveQueue(queue)'));
  check('generating leaves every other court\'s queue alone',
    (extractFn('generateLane', html) || '').includes('filter(g => queueCourtOf(g) !== court)'));

  // Viewer: Up Next / Final show a pill; a Live court looks exactly as before.
  check('viewer court cards take a status', /function buildCourtCard\(num, court, roundLabel, endingSoon, status\)/.test(html));
  check('viewer shows a pill only when a court is not live', viewerCard.includes("st !== 'live'") && viewerCard.includes('acourt-status'));
  check('viewer repaints when a status changes', (extractFn('renderViewer', html) || '').includes('cs: state.courtStatus'));

  // The old bespoke court-card styles are gone with the markup that used them.
  for (const dead of ['.crt-head{', '.crt-row{', '.crt-vs{', '.cc-label{', '.cc-round{', '.cc-ending{']) {
    check(`dead style ${dead} removed`, !html.includes(dead));
  }
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-court-cards — Courts cards in the Friendly pod format + live game clock\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  per-court status / lock / clock arrays normalize, set and stay pure');
  console.log('  PASS  taking a game restarts one court clock; undo winds it back');
  console.log('  PASS  formatElapsed renders M:SS and H:MM:SS and never goes backwards');
  console.log('  PASS  picking a taken court number swaps the two slots');
  console.log('  PASS  dropping a court shifts every slot-indexed field with it');
  console.log('  PASS  generating fills only the queue, so it cannot disturb a live court');
  console.log('  PASS  the clock chip only renders on a Live court, and one tap stops or starts it');
  console.log('  PASS  both boards render the pod controls; Courts stays score-free');
  console.log('\nRESULT: PASS — all court-card assertions green.');
  process.exit(0);
}
