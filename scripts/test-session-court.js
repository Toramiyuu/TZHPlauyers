#!/usr/bin/env node
/*
 * test-session-court.js — behavioural guard for the session ↔ court linkage.
 *
 * Bug: a player removed from today's session kept their slot inside
 * state.rounds[].courts[], so playerById() resolved the lingering id against
 * the permanent roster and the live court display still showed a player who
 * was no longer in the session.
 *
 * The fix introduces a PURE helper in public/index.html:
 *
 *   stripPlayerFromRounds(rounds, id) -> { rounds, changed }
 *
 * which returns a new rounds array with `id` replaced by '' (empty TBD slot)
 * in every team slot of every court, and a flag indicating whether anything
 * changed. This test extracts that helper from the inline <script> and asserts
 * its behaviour. Exit 0 = green, exit 1 = red.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(path.resolve(__dirname, '..'), 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// ── extract the function source by brace matching ──────────────────
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

const fnSrc = extractFn('stripPlayerFromRounds', html);

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

if (!fnSrc) {
  failures.push('stripPlayerFromRounds is not defined in public/index.html');
} else {
  // eslint-disable-next-line no-new-func
  const stripPlayerFromRounds = new Function(`${fnSrc}; return stripPlayerFromRounds;`)();

  // Fixture: 2 rounds, 2 courts each, p3 is on a court in both rounds.
  const make = () => ([
    { label: 'Round 1', courts: [
      { team1: ['p0', 'p1'], team2: ['p2', 'p3'] },
      { team1: ['p4', 'p5'], team2: ['p6', 'p7'] },
    ] },
    { label: 'Round 2', courts: [
      { team1: ['p3', 'p1'], team2: ['p2', 'p0'] },
      { team1: ['', ''], team2: ['p6', 'p7'] },
    ] },
  ]);

  // 1. Removing a player strips them from EVERY slot across all rounds.
  {
    const { rounds, changed } = stripPlayerFromRounds(make(), 'p3');
    const all = rounds.flatMap(r => r.courts.flatMap(c => [...c.team1, ...c.team2]));
    check('strips p3 from all slots', !all.includes('p3'));
    check('reports changed=true when present', changed === true);
    check('replaces with empty string (TBD), not deletion',
      rounds[0].courts[0].team2[1] === '' && rounds[1].courts[0].team1[0] === '');
  }

  // 2. Other players are untouched.
  {
    const { rounds } = stripPlayerFromRounds(make(), 'p3');
    check('p0 untouched', rounds[0].courts[0].team1[0] === 'p0');
    check('p7 untouched', rounds[1].courts[1].team2[1] === 'p7');
    check('court count preserved', rounds[0].courts.length === 2 && rounds[1].courts.length === 2);
    check('labels preserved', rounds[0].label === 'Round 1' && rounds[1].label === 'Round 2');
  }

  // 3. Removing an absent player reports no change.
  {
    const { changed } = stripPlayerFromRounds(make(), 'pX');
    check('reports changed=false when absent', changed === false);
  }

  // 4. Purity: the input array is not mutated.
  {
    const input = make();
    stripPlayerFromRounds(input, 'p3');
    check('does not mutate input', input[0].courts[0].team2[1] === 'p3');
  }

  // 5. Defensive: handles empty / missing rounds.
  {
    const a = stripPlayerFromRounds([], 'p3');
    const b = stripPlayerFromRounds(undefined, 'p3');
    check('empty rounds -> changed=false', a.changed === false && Array.isArray(a.rounds));
    check('undefined rounds -> changed=false', b.changed === false && Array.isArray(b.rounds));
  }
}

console.log('test-session-court — session ↔ court linkage\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  stripPlayerFromRounds strips removed players from every court slot');
  console.log('\nRESULT: PASS — all session/court assertions green.');
  process.exit(0);
}
