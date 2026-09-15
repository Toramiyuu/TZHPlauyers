#!/usr/bin/env node
/*
 * test-round-editor-mobile.js — the round / Up Next court editor on phones.
 *
 * Reported 2026-09-15 ("the vs is not spaced properly, below which court has
 * too little space and below vs has too much space"). Stacked flat, the editor
 * had two problems:
 *
 *   1. A "Court 3" heading sat 8px above the teams it titled and 14px below the
 *      previous court's Team B slots — near-equal gaps, so it read as a trailer
 *      to the court above rather than a title for the one below. Each court is
 *      now its own card, which makes the grouping unambiguous.
 *
 *   2. "VS" was a word floating centred between the two team blocks, with the
 *      Team B LABEL underneath it — so the space above it (a row gap) and below
 *      it (a row gap plus a label line) never matched. It is now a full-width
 *      rule with VS set into it, so the row gap is the only space on each side.
 *
 * CSS-only, so this is a stylesheet guard: it pins the rules that carry those
 * two fixes, not the exact pixel values.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

// The phone block is the @media(max-width:640px) that carries the court card.
const at = html.indexOf('.court-editor{background');
const start = at === -1 ? -1 : html.lastIndexOf('@media(max-width:640px){', at);
const mq = start === -1 ? '' : html.slice(start, html.indexOf('\n}', start));

check('there is a max-width:640px block styling the court editor', mq.length > 0);

// ── 1. each court is its own card ──────────────────────────────────
const card = /\.court-editor\{([^}]*)\}/.exec(mq)?.[1] || '';
check('the court card has its own surface', /background:var\(--card2\)/.test(card));
check('the court card is outlined', /border:1px solid var\(--border\)/.test(card));
check('the court card is rounded', /border-radius:var\(--radius-/.test(card));
check('the court card has inner padding', /padding:\d+px/.test(card));
check('cards are separated from each other', /margin-bottom:\d+px/.test(card));

const h4 = /\.court-editor h4\{([^}]*)\}/.exec(mq)?.[1] || '';
const gapUnderHeading = Number(/margin-bottom:(\d+)px/.exec(h4)?.[1] || 0);
check('the court heading has real space under it (>=12px, was 8px)', gapUnderHeading >= 12);

// The plain chip is --card2 too, so on a --card2 card it would disappear. The
// .off (amber) and .mx (pink) chips carry their own tint and must keep it —
// a bare `.court-editor .court-balance` rule would outrank them on source order.
check('the plain balance chip is lifted off the card it now sits on',
  /\.court-editor \.court-balance:not\(\.off\):not\(\.mx\)\{background:var\(--card\)\}/.test(mq));
check('the amber / pink balance chips keep their own tint',
  !/\.court-editor \.court-balance\{/.test(mq));

// ── 2. VS is a rule, not a floating word ───────────────────────────
const vs = /\.selectors-row>\.vs-small\{([^}]*)\}/.exec(mq)?.[1] || '';
check('VS spans the full width of the stacked row', /align-self:stretch/.test(vs));
check('VS is no longer centred as a floating word', !/align-self:center/.test(vs));
check('VS carries no padding of its own (the row gap is the spacing)', /padding:0/.test(vs));
check('VS lays its label out between two lines', /display:flex/.test(vs) && /align-items:center/.test(vs));
check('the two hairlines are drawn and share the leftover width',
  /\.selectors-row>\.vs-small::before,\.selectors-row>\.vs-small::after\{[^}]*content:""[^}]*flex:1[^}]*height:1px/.test(mq));

// ── desktop is untouched ───────────────────────────────────────────
// The complaint was mobile-only; the wide layout puts both teams side by side
// on one row, where VS between them and flat court sections already read fine.
const base = /\n\.court-editor\{([^}]*)\}/.exec(html)?.[1] || '';
check('the wide layout keeps flat court sections (no card)', !/background/.test(base));

// ── report ─────────────────────────────────────────────────────────
console.log('test-round-editor-mobile — court cards + VS rule on phones\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
}
console.log('  PASS  each court is its own card, heading titled to the teams below it');
console.log('  PASS  VS is a full-width rule with symmetric space on both sides');
console.log('  PASS  balance chips stay legible on the card; desktop unchanged');
console.log('\nRESULT: PASS — mobile round-editor assertions green.');
process.exit(0);
