#!/usr/bin/env node
/* test-roster-list-ui — Session > Players "List" view on phones (2026-09-12).
 *
 * On a 390px screen the five fixed columns (level input + 52 Girl + 72 Mixed +
 * 44 Pts + four gaps) consumed the whole row, so .rl-name got ~0px and every
 * name truncated to a single letter. The fix folds Level / Girl / Mixed into a
 * per-row drawer behind a chevron, leaving Player / more / Pts on the line.
 *
 * This guards the DOM + CSS glue: the drawer state survives a poll re-render,
 * only one row opens at a time, the chevron never toggles session membership,
 * and the desktop five-column table is left alone. */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

function extractFn(name, src) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start === -1) return null;
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const fn = (name) => extractFn(name, html) || '';

// ── behaviour: the open-drawer latch (pure, run in isolation) ──
const mod = new Function(`
  let __rlOpen = null, renders = 0;
  function renderPlayersSection(){ renders++; }
  ${fn('toggleRosterMore')}
  return { toggle: toggleRosterMore, open: () => __rlOpen, renders: () => renders };
`)();

mod.toggle('p3');
check('tapping the chevron opens that row', mod.open() === 'p3');
check('opening repaints the list', mod.renders() === 1);
mod.toggle('p7');
check('opening another row closes the first (one drawer at a time)', mod.open() === 'p7');
mod.toggle('p7');
check('tapping the same chevron again closes it', mod.open() === null);
mod.toggle('p7');
mod.toggle('p1');
check('the latch always holds exactly one id or null', mod.open() === 'p1');

// ── the latch lives outside the render, so a poll tick cannot fold it shut ──
check('__rlOpen is module-level, not a local of renderRosterList', /\blet __rlOpen = null;/.test(html) && !fn('renderRosterList').includes('let __rlOpen'));
check('renderRosterList reads the latch to re-apply the open class', fn('renderRosterList').includes('const open = __rlOpen === rp.id;') && fn('renderRosterList').includes("${open ? ' open' : ''}"));
check('leaving the List view clears the drawer', fn('setRosterView').includes('__rlOpen = null;'));

// ── row markup ──
const row = fn('renderRosterList');
check('the chevron is a real button with aria-expanded', row.includes('<button type="button" class="rl-more" aria-expanded="${open}"') && row.includes("onclick=\"toggleRosterMore('${rp.id}')\""));
check('the chevron carries a per-player aria-label', row.includes("aria-label=\"${open ? 'Hide' : 'Show'} level, girl and mixed for ${escHtml(rp.name)}\""));
check('the chevron flips glyph with state', row.includes("${open ? '\\u2303' : '\\u2304'}"));
check('the chevron sits between Mixed and Pts, outside .rl-player', row.indexOf('class="rl-more"') > row.indexOf('class="rl-mixed"') && row.indexOf('class="rl-more"') < row.indexOf('class="rl-pts"'));
check('the chevron is a sibling of .rl-player, so it never toggles the session', !/rl-player[\s\S]*?rl-more[\s\S]*?<\/div>\s*<div class="rl-level"/.test(row));
check('Level / Girl / Mixed cells are still rendered once (moved by CSS, not duplicated)', (row.match(/class="rl-level"/g) || []).length === 1 && (row.match(/class="rl-girl"/g) || []).length === 1 && (row.match(/class="rl-mixed"/g) || []).length === 1);

// ── CSS ──
check('the chevron is hidden outside the phone breakpoint', html.includes('.rl-more{display:none}'));
check('the desktop five-column grid is unchanged', html.includes('.rl-head,.rl-row{display:grid;grid-template-columns:1fr auto 52px 72px 44px;align-items:center;gap:12px;padding:10px 14px}'));
check('the phone breakpoint is 560px', html.includes('@media(max-width:560px){'));
const mq = html.slice(html.indexOf('@media(max-width:560px){'), html.indexOf('@media(max-width:560px){') + 2000);
check('phone rows collapse to Player / chevron / Pts', mq.includes('.rl-head,.rl-row{grid-template-columns:1fr 40px 44px;'));
check('the Level/Girl/Mixed headers drop out on phones', mq.includes('.rl-head span:nth-child(2),.rl-head span:nth-child(3),.rl-head span:nth-child(4){display:none}'));
check('Pts stays in the last column in the header', mq.includes('.rl-head span:nth-child(5){grid-column:3}'));
check('attribute cells are hidden until the row is open', mq.includes('.rl-level,.rl-girl,.rl-mixed{display:none;') && mq.includes('.rl-row.open .rl-level,.rl-row.open .rl-girl,.rl-row.open .rl-mixed{display:flex}'));
check('open cells stack on their own full-width rows', mq.includes('.rl-row.open .rl-level{grid-area:2/1/auto/-1') && mq.includes('.rl-row.open .rl-girl{grid-area:3/1/auto/-1') && mq.includes('.rl-row.open .rl-mixed{grid-area:4/1/auto/-1'));
check('each control is labelled in the drawer', mq.includes(".rl-level::before{content:'Level'}") && mq.includes(".rl-girl::before{content:'Girl'}") && mq.includes(".rl-mixed::before{content:'Mixed doubles'}"));
check('the chevron has a 40px touch target', mq.includes('width:40px;height:40px'));
check('the toggles stop centring themselves inside the drawer', mq.includes('.rl-girl .rl-toggle,.rl-mixed .rl-toggle{margin:0}'));
check('the level input gets room back', mq.includes('.rl-lvl-inp{width:78px;padding:8px}'));
check('the old 430px column-cramming rule is gone', !html.includes('@media(max-width:430px){.rl-head,.rl-row{gap:7px'));
check('no !important in the phone rules', !/!important/.test(mq));

console.log(`\ntest-roster-list-ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
