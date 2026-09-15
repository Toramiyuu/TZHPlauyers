#!/usr/bin/env node
/* test-round-summary — the Round / Match row in the Courts tab (2026-09-12).
 *
 * Reported as "does not show me the match number and round number": squeezed
 * into the flex:1 remainder of a narrow row, the whole summary ellipsised down
 * to "C1: C…", so the match the row described was unreadable. Each match is now
 * its own element and stacks onto its own line below 560px.
 *
 * It also hardcoded C1..Cn while the editor heading right underneath used
 * courtLabel() — a venue playing on courts 3 and 4 saw "C1" over "Court 3". */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
function extractFn(name, s) {
  const start = s.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = s.indexOf('{', start);
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d++;
    else if (s[i] === '}') { d--; if (d === 0) return s.slice(start, i + 1); }
  }
  return null;
}

// Run the real roundSummary against stub helpers.
const summary = new Function(`
  const NAMES = { p1:'Celine', p2:'Kokyan', p3:'Sharmin', p4:'Alex', p5:'Desmond', p6:'Yit Fung', p7:'Harvey', p8:'Terence', px:'<img src=x>' };
  let COURT_NUMBERS = null;
  function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function playerById(id){ return NAMES[id] ? { name: NAMES[id] } : null; }
  const state = { get courtNumbers(){ return COURT_NUMBERS; } };
  ${extractFn('courtLabel', html)}
  ${extractFn('roundSummary', html)}
  return { run: roundSummary, setCourts: (v) => { COURT_NUMBERS = v; } };
`)();

const ROUND = {
  courts: [
    { team1: ['p1', 'p2'], team2: ['p3', 'p4'] },
    { team1: ['p5', 'p6'], team2: ['p7', 'p8'] },
  ],
};

summary.setCourts(null);
let out = summary.run(ROUND);
check('every match becomes its own .rs-m element', (out.match(/class="rs-m"/g) || []).length === 2);
check('both matches name all four players', ['Celine', 'Kokyan', 'Sharmin', 'Alex', 'Desmond', 'Yit Fung', 'Harvey', 'Terence'].every(n => out.includes(n)));
check('the court number is marked up separately so it can be emphasised', out.includes('<b class="rs-c">C1</b>') && out.includes('<b class="rs-c">C2</b>'));
check('teams are wrapped so they can wrap as units', (out.match(/class="rs-t"/g) || []).length === 4);
check('a separator sits between matches, not after the last one', (out.match(/class="rs-sep"/g) || []).length === 1);
check('the "v" is its own element so the phone layout can space it', out.includes('<i class="rs-v">v</i>'));

summary.setCourts([3, 4]);
out = summary.run(ROUND);
check('court numbers follow courtLabel, matching the editor headings', out.includes('>C3<') && out.includes('>C4<') && !out.includes('>C1<'));
summary.setCourts([2]);
check('a short courtNumbers list falls back to the index for the rest', (() => {
  const o = summary.run(ROUND);
  return o.includes('>C2<') && o.includes('>C2<');
})());
summary.setCourts(null);

check('an empty round produces nothing rather than throwing', summary.run({ courts: [] }) === '' && summary.run({}) === '');
check('a missing player renders as ? instead of breaking the row', summary.run({ courts: [{ team1: ['p1', 'nope'], team2: ['p3', 'p4'] }] }).includes('?'));
check('player names are escaped — they land in innerHTML', (() => {
  const o = summary.run({ courts: [{ team1: ['px', 'p1'], team2: ['p3', 'p4'] }] });
  return o.includes('&lt;img src=x&gt;') && !o.includes('<img src=x>');
})());

// ── CSS ──
const i = html.lastIndexOf('@media(max-width:560px){', html.indexOf('.rl-hdr-match{display:none}'));
const mq = html.slice(i, html.indexOf('\n}', i));
check('the round row is allowed to wrap on phones', /\.round-row-header\{flex-wrap:wrap;row-gap:\d+px;column-gap:\d+px/.test(mq));
check('the summary takes a full line of its own, ordered last', mq.includes('.rsummary{order:5;flex:1 0 100%;'));
// The live dot sits before the label on line 1; without the indent the match
// lines started under the dot instead of under "Round 1".
check('the match lines hang under the round label, not the live dot', /\.rsummary\{order:5;flex:1 0 100%;padding-left:1[5-9]px/.test(mq));
check('the summary stops truncating once it has a line to itself', mq.includes('white-space:normal;overflow:visible;text-overflow:clip'));
check('each match goes on its own line', mq.includes('.rs-m{display:block;'));
// Flexed, the two teams were justified to opposite edges of the row with the
// "v" stranded in the middle; a hanging indent wraps them as ordinary text.
check('a long match wraps under its court chip, not around it',
  /\.rs-m\{display:block;padding-left:(\d+)px;text-indent:-\1px\}/.test(mq) && mq.includes('.rs-c{display:inline-block;min-width:19px;text-indent:0}'));
check('the inline separator is dropped once matches are stacked', mq.includes('.rs-sep{display:none}'));
check('the MATCH heading is dropped — nothing lines up under it when stacked', mq.includes('.rl-hdr-match{display:none}'));
check('the round label stops reserving a fixed width', mq.includes('.rl{min-width:0;flex:1}'));
check('.rsummary can actually shrink on desktop (min-width:0 for the ellipsis)', html.includes('.rsummary{font-size:var(--fs-sm);color:var(--text-2);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'));
check('the court number is the blue accent, not the forbidden old green', html.includes('.rs-c{font-weight:700;color:var(--a-blue,#0071e3);margin-right:5px}'));
check('no !important in the new rules', !/\.rs-[a-z]+[^\n]*!important/.test(html));

console.log(`\ntest-round-summary: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
