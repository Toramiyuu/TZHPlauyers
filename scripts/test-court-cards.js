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
 *   restampCourtLive                          restart the clock of Live courts
 *                                             whose round changed
 *   formatElapsed                             ms -> M:SS / H:MM:SS
 *   setCourtNumberAt                          pick a court number (swaps on clash)
 *   applyCourtDrop                            drop one court slot from the day
 *   applyLockedFirstRound                     keep locked courts in round 1
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
  'normalizeCourtLive', 'setCourtLiveAt', 'restampCourtLive',
  'formatElapsed', 'setCourtNumberAt', 'applyCourtDrop',
  'applyLockedFirstRound', 'liveClockHTML',
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

  // ── restampCourtLive ────────────────────────────────────────────
  {
    const { restampCourtLive: restamp } = H;
    const NOW = 1700000000000;
    // 1. A Live court that moved round restarts its clock.
    {
      const a = restamp([111, 222], ['live', 'live'], [0, 0], [1, 0], 2, NOW);
      check('restampCourtLive: restarts the court that changed round', a && a[0] === NOW);
      check('restampCourtLive: leaves the unchanged court alone', a && a[1] === 222);
    }
    // 2. A court that is NOT live has no game running — its clock stays stopped.
    {
      const a = restamp([111, 222], ['next', 'final'], [0, 0], [1, 1], 2, NOW);
      check('restampCourtLive: a non-live court is stopped, not restarted', a && a[0] === 0 && a[1] === 0);
    }
    // 3. Nothing changed round -> null, so the caller can skip the write.
    {
      check('restampCourtLive: no round change -> null',
        restamp([111, 222], ['live', 'live'], [0, 1], [0, 1], 2, NOW) === null);
    }
    // 4. Already-stopped non-live courts changing round is still null (no churn).
    {
      check('restampCourtLive: stopped non-live court -> null',
        restamp([0, 0], ['next', 'next'], [0, 0], [1, 1], 2, NOW) === null);
    }
    // 5. Pure, and missing status/round arrays are tolerated.
    {
      const input = [111, 222];
      restamp(input, ['live', 'live'], [0, 0], [1, 1], 2, NOW);
      check('restampCourtLive: does not mutate input', input[0] === 111);
      check('restampCourtLive: missing status -> treated as live',
        (restamp([0, 0], undefined, [0, 0], [1, 1], 2, NOW) || [])[0] === NOW);
    }
  }

  // ── formatElapsed ───────────────────────────────────────────────
  {
    const { formatElapsed: fmt } = H;
    check('formatElapsed: zero', fmt(0) === '0:00');
    check('formatElapsed: seconds pad to two digits', fmt(7000) === '0:07');
    check('formatElapsed: minutes do not pad', fmt(9 * 60000 + 5000) === '9:05');
    check('formatElapsed: past ten minutes', fmt(12 * 60000 + 34000) === '12:34');
    check('formatElapsed: an hour switches to H:MM:SS', fmt(3600000) === '1:00:00');
    check('formatElapsed: H:MM:SS pads minutes', fmt(3600000 + 5 * 60000 + 9000) === '1:05:09');
    check('formatElapsed: rounds down to the whole second', fmt(1999) === '0:01');
    // A future or junk stamp must read 0:00 — the clock never runs backwards.
    check('formatElapsed: negative reads zero', fmt(-5000) === '0:00');
    check('formatElapsed: junk reads zero', fmt('x') === '0:00' && fmt(undefined) === '0:00');
  }

  // ── setCourtNumberAt ────────────────────────────────────────────
  {
    const { setCourtNumberAt: set } = H;
    // 1. A free number is simply taken.
    {
      const a = set([1, 2], 1, 2, 4);
      check('setCourtNumberAt: takes a free number', a[0] === 1 && a[1] === 4);
    }
    // 2. A number another slot owns SWAPS the two — labels stay unique.
    {
      const a = set([3, 4], 0, 2, 4);
      check('setCourtNumberAt: clashing number swaps the two slots', a[0] === 4 && a[1] === 3);
      check('setCourtNumberAt: no duplicate labels after a swap', new Set(a).size === 2);
    }
    // 3. Re-picking the number a slot already has changes nothing.
    {
      const a = set([1, 2], 0, 2, 1);
      check('setCourtNumberAt: re-picking the same number is a no-op', a[0] === 1 && a[1] === 2);
    }
    // 4. Junk, out-of-range slots and pre-feature state are all safe.
    {
      check('setCourtNumberAt: out-of-range slot is a no-op', set([1, 2], 5, 2, 3)[0] === 1);
      check('setCourtNumberAt: junk number is a no-op', set([1, 2], 0, 2, 'x')[0] === 1);
      check('setCourtNumberAt: zero/negative is a no-op', set([1, 2], 0, 2, 0)[0] === 1);
      const a = set(undefined, 1, 2, 3);
      check('setCourtNumberAt: missing courtNumbers falls back to slot+1', a[0] === 1 && a[1] === 3);
    }
    // 5. Pure.
    {
      const input = [1, 2];
      set(input, 0, 2, 4);
      check('setCourtNumberAt: does not mutate input', input[0] === 1);
    }
  }

  // ── applyCourtDrop ──────────────────────────────────────────────
  {
    const { applyCourtDrop: drop } = H;
    const base = () => ({
      numCourts: 3,
      currentRound: 0,
      courtNumbers: [1, 2, 3],
      courtRounds: [0, 1, 2],
      endingSoon: [false, true, false],
      courtStatus: ['live', 'next', 'final'],
      courtLocks: [false, false, true],
      courtLive: [0, 111, 222],
      rounds: [
        { label: 'R1', courts: [{ team1: ['a', 'b'], team2: ['c', 'd'] }, { team1: ['e', 'f'], team2: ['g', 'h'] }, { team1: ['i', 'j'], team2: ['k', 'l'] }] },
        { label: 'R2', courts: [{ team1: ['1'], team2: ['2'] }, { team1: ['3'], team2: ['4'] }, { team1: ['5'], team2: ['6'] }] },
      ],
    });
    // 1. Dropping the MIDDLE court shifts everything indexed by slot, so the
    //    courts that stay keep their own pairings instead of inheriting.
    {
      const u = drop(base(), 1);
      check('applyCourtDrop: numCourts falls by one', u.numCourts === 2);
      check('applyCourtDrop: court numbers shift', u.courtNumbers.join() === '1,3');
      check('applyCourtDrop: round pointers shift', u.courtRounds.join() === '0,2');
      check('applyCourtDrop: ending-soon flags shift', u.endingSoon.join() === 'false,false');
      check('applyCourtDrop: statuses shift', u.courtStatus.join() === 'live,final');
      check('applyCourtDrop: locks shift', u.courtLocks.join() === 'false,true');
      check('applyCourtDrop: game clocks shift', u.courtLive.join() === '0,222');
      check('applyCourtDrop: every round loses that court slot',
        u.rounds.length === 2 && u.rounds.every(r => r.courts.length === 2));
      check('applyCourtDrop: the surviving courts keep their own players',
        u.rounds[0].courts[0].team1.join() === 'a,b' && u.rounds[0].courts[1].team1.join() === 'i,j');
      check('applyCourtDrop: round labels survive', u.rounds[1].label === 'R2');
    }
    // 2. Dropping the last slot works too.
    {
      const u = drop(base(), 2);
      check('applyCourtDrop: drops the last slot', u.courtNumbers.join() === '1,2' && u.rounds[0].courts.length === 2);
    }
    // 3. Refuses to leave the day with no court, and ignores bad indexes.
    {
      check('applyCourtDrop: the last remaining court cannot be dropped',
        drop({ numCourts: 1, rounds: [] }, 0) === null);
      check('applyCourtDrop: out-of-range index -> null', drop(base(), 7) === null);
      check('applyCourtDrop: negative index -> null', drop(base(), -1) === null);
    }
    // 4. Pure, and tolerant of pre-feature state that has only numCourts.
    {
      const input = base();
      drop(input, 1);
      check('applyCourtDrop: does not mutate input',
        input.numCourts === 3 && input.rounds[0].courts.length === 3 && input.courtNumbers.join() === '1,2,3');
      const u = drop({ numCourts: 2 }, 0);
      check('applyCourtDrop: bare state still yields a full update',
        u && u.numCourts === 1 && u.courtNumbers.join() === '2' && u.courtRounds.join() === '0'
        && u.courtStatus.join() === 'live' && Array.isArray(u.rounds) && u.rounds.length === 0);
    }
  }

  // ── applyLockedFirstRound ───────────────────────────────────────
  {
    const { applyLockedFirstRound: lock } = H;
    const gen = () => [
      { label: 'R1', courts: [
        { team1: ['a', 'b'], team2: ['c', 'd'] },
        { team1: ['e', 'f'], team2: ['g', 'h'] },
      ] },
      { label: 'R2', courts: [
        { team1: ['a', 'c'], team2: ['e', 'g'] },
        { team1: ['b', 'd'], team2: ['f', 'h'] },
      ] },
    ];
    // 1. A locked court's four are swapped back onto it in round 1.
    {
      const want = { team1: ['a', 'e'], team2: ['c', 'g'] };
      const out = lock(gen(), [true, false], [want, null]);
      const c0 = out[0].courts[0];
      check('applyLockedFirstRound: locked court gets its four back',
        c0.team1.join() === 'a,e' && c0.team2.join() === 'c,g');
      // Whoever they displaced took the seats the locked players came from, so
      // round 1 still holds exactly the same eight players.
      const ids = out[0].courts.flatMap(c => [...c.team1, ...c.team2]).sort().join();
      check('applyLockedFirstRound: round 1 keeps the same eight players', ids === 'a,b,c,d,e,f,g,h');
      check('applyLockedFirstRound: no player is seated twice',
        new Set(out[0].courts.flatMap(c => [...c.team1, ...c.team2])).size === 8);
    }
    // 2. A locked player the scheduler had RESTING in round 1 still gets their
    //    seat; the person they displace is the one who rests instead.
    {
      const out = lock(gen(), [true, false], [{ team1: ['a', 'z'], team2: ['c', 'd'] }, null]);
      const c0 = out[0].courts[0];
      check('applyLockedFirstRound: a resting locked player is seated',
        c0.team1.join() === 'a,z' && c0.team2.join() === 'c,d');
      check('applyLockedFirstRound: the displaced player is benched, not duplicated',
        !out[0].courts.flatMap(c => [...c.team1, ...c.team2]).includes('b'));
      check('applyLockedFirstRound: the other court is untouched by a bench swap',
        out[0].courts[1].team1.join() === 'e,f' && out[0].courts[1].team2.join() === 'g,h');
    }
    // 3. Later rounds are left entirely to the scheduler.
    {
      const out = lock(gen(), [true, false], [{ team1: ['a', 'e'], team2: ['c', 'g'] }, null]);
      check('applyLockedFirstRound: round 2 is untouched',
        out[1].courts[0].team1.join() === 'a,c' && out[1].courts[1].team2.join() === 'f,h');
    }
    // 4. Unlocked, missing and empty pairings are skipped.
    {
      const out = lock(gen(), [false, false], [{ team1: ['x', 'y'], team2: ['z', 'w'] }, null]);
      check('applyLockedFirstRound: an unlocked court is untouched',
        out[0].courts[0].team1.join() === 'a,b');
      const out2 = lock(gen(), [true, true], [null, undefined]);
      check('applyLockedFirstRound: a locked court with no pairing is untouched',
        out2[0].courts[0].team1.join() === 'a,b' && out2[0].courts[1].team1.join() === 'e,f');
      const out3 = lock(gen(), [true, false], [{ team1: ['g', ''], team2: ['', ''] }, null]);
      check('applyLockedFirstRound: empty slots in a pairing are skipped',
        out3[0].courts[0].team1[0] === 'g' && out3[0].courts[0].team1[1] === 'b');
    }
    // 5. Pure, and safe on an empty schedule.
    {
      const input = gen();
      lock(input, [true, false], [{ team1: ['a', 'e'], team2: ['c', 'g'] }, null]);
      check('applyLockedFirstRound: does not mutate input', input[0].courts[0].team1.join() === 'a,b');
      check('applyLockedFirstRound: empty schedule -> []', lock([], [true], [{}]).length === 0);
      check('applyLockedFirstRound: missing rounds -> []', lock(undefined, [true], [{}]).length === 0);
    }
  }

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
  check('Courts cards keep the round nav', courtsRender.includes('crt-rnav') && courtsRender.includes('advanceCourt('));
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

  // A new game on a court restarts its clock.
  for (const fn of ['advanceCourt', 'startNextRound', 'stepAllCourts', 'setCurrentRound']) {
    check(`${fn} restarts the clocks of courts that changed round`, (extractFn(fn, html) || '').includes('restampCourtLive('));
  }
  check('a fresh schedule clears every game clock', (extractFn('generateSchedule', html) || '').includes('courtLive'));
  check('a fresh schedule honours locked courts', (extractFn('generateSchedule', html) || '').includes('applyLockedFirstRound('));

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
  console.log('  PASS  a court changing round restarts its clock (Live only)');
  console.log('  PASS  formatElapsed renders M:SS and H:MM:SS and never goes backwards');
  console.log('  PASS  picking a taken court number swaps the two slots');
  console.log('  PASS  dropping a court shifts every slot-indexed field with it');
  console.log('  PASS  locked courts keep their four in round 1 of a new schedule');
  console.log('  PASS  the clock chip only renders on a Live court, and one tap stops or starts it');
  console.log('  PASS  both boards render the pod controls; Courts stays score-free');
  console.log('\nRESULT: PASS — all court-card assertions green.');
  process.exit(0);
}
