#!/usr/bin/env node
/* Static source assertions for the Session Lucky Draw UI in public/index.html
 * (same style as test-payments-ui.js): the public page exists and is wired into
 * the viewer nav, the overlay registry and the #draw deep link; the admin
 * "Session draws" sub-tab has the winners setting + Run draw now; the retired
 * Weekly UI is gone; and the shared card renderer produces the four lists with
 * winners visually marked. Also evaluates the pure card renderer against a
 * fixture so the markup contract is checked, not just grepped. */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SD = require('../public/session-draw.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

function extractFn(name, src) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) return '';
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return '';
}
const fn = (name) => extractFn(name, html);

// ── wiring ──
check('session-draw.js is loaded as a UMD lib', /<script src="\/session-draw\.js"><\/script>/.test(html));
check('viewer header has the Lucky Draw button styled like its siblings', /<button id="drawBtn" onclick="openDrawPage\(\)">/.test(html) && /\.vh-nav #td3Btn,\.vh-nav #drawBtn\{/.test(html) && /\.vh-nav #td3Btn:hover,\.vh-nav #drawBtn:hover\{/.test(html));
check('#drawPage overlay exists with title, how-it-works, list and "older" button', /<div id="drawPage" role="dialog"/.test(html) && html.includes('id="drawPageHow"') && html.includes('id="drawPageList"') && html.includes('id="drawPageMore"'));
check('#drawPage is registered in closeOpenOverlays', fn('closeOpenOverlays').includes("isOpen('drawPage')") && fn('closeOpenOverlays').includes('closeDrawPage()'));
check('#draw deep link is honoured after the site unlocks', fn('sdAfterPoll').includes("'#draw'") && fn('poll').includes('sdAfterPoll()'));
check('page data comes from /api/draws with the site code, not the 2s poll', fn('fetchPublicDraws').includes("fetch('/api/draws?'") && fn('fetchPublicDraws').includes("localStorage.getItem('siteCode')") && !fn('poll').includes('loadDrawPage'));
check('page refreshes every 30s while open and stops on close', fn('openDrawPage').includes('30000') && fn('closeDrawPage').includes('clearInterval(sdPublicTimer)'));
check('locked response shows a site-code hint instead of an error', fn('loadDrawPage').includes('res.locked') && /site code/.test(fn('loadDrawPage')));
check('how-it-works copy comes from the shared module', fn('sdHowHtml').includes('SessionDraw.howItWorksText('));
check('"My Lucky Draw" links to the public page and no longer claims weekly wins', fn('renderMyDraw').includes('openDrawPage()') && !fn('renderMyDraw').includes('Won!'));

// ── admin sub-tab ──
check('Lucky Draw sub-tab is relabelled "Session draws"', /data-sub="weekly" onclick="setLuckyTab\('weekly'\)">Session draws<\/button>/.test(html));
check('setLuckyTab renders the session draws admin view', fn('setLuckyTab').includes("if (sub === 'weekly') { renderSessionDrawsAdmin(); }"));
check('setAdminTab engagement hook loads ops then renders', fn('setAdminTab').includes('renderSessionDrawsAdmin()') && !fn('setAdminTab').includes('renderWeeklyTab'));
check('winners stepper + numeric input post setDrawSettings', html.includes('id="sdWinnersInput"') && html.includes('onclick="stepDrawWinners(-1)"') && fn('setDrawWinners').includes("action: 'setDrawSettings'") && fn('setDrawWinners').includes('SessionDraw.isWinnersCount('));
check('admin list uses the getDraws action with paging', fn('loadAdminDraws').includes("action: 'getDraws'") && fn('loadAdminDraws').includes('nextBefore'));
check('Run draw now posts runDraw and guards double taps', fn('runDrawNow').includes("action: 'runDraw'") && fn('runDrawNow').includes('sdBusy.has(date)'));
check('Run draw now only renders for due + pending sessions in admin mode', fn('sdCardHtml').includes('if (admin && !done && v.due)'));
check('Manual quick draw block is preserved', html.includes('id="paidPicker"') && html.includes('onclick="spinDraw()"'));
check('Manual quick draw summary shows a +/\u2013 disclosure indicator and hint', /\.ld-quick-card summary::after\{content:"\+"/.test(html) && /\.ld-quick-card\[open\] summary::after\{content:"\\2013"\}/.test(html) && html.includes('class="ld-quick-hint"') && /\.ld-quick-card:not\(\[open\]\) summary\{margin-bottom:0\}/.test(html));
check('guided tour spotlights the automatic draw card, then the manual spin', html.includes('id="sdAutoCard"') && /sub: 'weekly', sel: '#sdAutoCard'/.test(html) && /sub: 'weekly', sel: '#spinBtn'/.test(html) && !/title: 'Tick who has paid'/.test(html));
check('guided tour switches to the Session draws sub-tab', fn('showTourStep').includes('setLuckyTab(step.sub)'));
check('guided tour opens collapsed <details> ancestors before measuring', fn('positionTourStep').includes("el.closest('details')") && fn('positionTourStep').includes('d.open = true'));
check('help drawer describes the session draw', /Lucky Draw &mdash; Session draws/.test(html) && /Run draw now/.test(html));
check('audit labels cover the new actions', /'draw\.run':/.test(html) && /'draw\.settings':/.test(html));
check('adminOps carries drawSettings, not the retired weekly keys', fn('loadAdminOps').includes('drawSettings: res.drawSettings') && !fn('loadAdminOps').includes('weeklyDraws'));

// ── retired Weekly UI is gone ──
for (const sym of ['renderWeeklyTab', 'checkForNewWeeklyDraw', 'weeklyConfirm', 'toggleAtt(', 'seedWeeklyDay', 'weekStep(', 'id="weeklyGroups"', 'id="weeklyHistory"', 'state.weeklyDraws', 'weeklySettings', '.wk-row{', '.week-nav{']) {
  check('retired: ' + sym, !html.includes(sym));
}
const section = html.slice(html.indexOf('// ── SESSION LUCKY DRAW'), html.indexOf('// ── ADMIN: PAYMENTS'));
check('session draw section has no native confirm/alert/prompt', section.length > 2000 && !/\b(confirm|alert|prompt)\(/.test(section));

// ── CSS ──
check('winners are visually marked (row tint + chip + tag)', /\.sd-row\.win\{background:var\(--a-blue-tint\);font-weight:700/.test(html) && /\.sd-win-chip\{[^}]*background:var\(--a-blue\)/.test(html) && /\.sd-win-tag\{/.test(html));
check('four stat tiles + expandable lists', /\.sd-stats\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/.test(html) && /\.sd-names-wrap summary\{[^}]*min-height:44px/.test(html));
const mobile = html.slice(html.indexOf('@media(max-width:640px){'), html.indexOf('/* Desktop multi-column helpers'));
check('mobile: 44px targets for the stepper and admin button', /\.sd-stepper \.btn\{width:44px;height:44px\}/.test(mobile) && /\.sd-admin-row \.btn\{width:100%;min-height:44px\}/.test(mobile));
check('page overlay is opaque full-screen without backdrop-filter', /#drawPage\{display:none;position:fixed;inset:0;background:var\(--a-bg\)/.test(html) && !/#drawPage\{[^}]*backdrop-filter/.test(html));

// ── evaluate the card renderer against a fixture ──
const esc = 'function escHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\'/g, "&#39;"); }';
const src = esc + ';' + 'const SessionDraw = arguments[0]; const sdBusy = new Set();'
  + "const SD_LIST_KEYS = [['attended', 'Attended'], ['paid', 'Paid'], ['eligible', 'Eligible'], ['winners', 'Winners']];"
  + fn('sdWinnersLabel') + ';' + fn('sdListHtml') + ';' + fn('sdVideoRowHtml') + ';' + fn('sdCardHtml') + '; return sdCardHtml;';
const sdCardHtml = new Function(src)(SD);
const MON_AT = SD.scheduledDrawAt('2026-09-07', 8);
const rec = SD.buildDrawResult({ date: '2026-09-07', drawAt: MON_AT, winnersWanted: 2, seed: '00112233445566778899aabbccddeeff', nowMs: MON_AT + 60000, method: 'auto',
  day: { entries: {
    a: { playerId: 'a', name: 'Alice <b>', present: true, paid: true, payment: { paidAt: MON_AT - 60000 } },
    b: { playerId: 'b', name: 'Bob', present: true, paid: true, payment: { paidAt: MON_AT - 120000 } },
    c: { playerId: 'c', name: 'Cara', present: true, paid: true, payment: { paidAt: MON_AT + 60000 } },
    d: { playerId: 'd', name: 'Dan', present: true, paid: false },
  } }, lineup: [] });
const doneView = SD.viewOf({ date: '2026-09-07' }, rec, MON_AT + 120000, { winners: 2 });
const doneHtml = sdCardHtml(doneView, true);
const pubDoneHtml = sdCardHtml(doneView, false);
check('done card: winner chips + Winner tags + tinted rows', (doneHtml.match(/sd-win-chip/g) || []).length === 2 && (doneHtml.match(/class="sd-row win"/g) || []).length >= 2 && doneHtml.includes('sd-win-tag'));
check('done card: four lists with counts 4/3/2/2', /<summary><span>Attended<\/span><b>4/.test(doneHtml) && /<summary><span>Paid<\/span><b>3/.test(doneHtml) && /<summary><span>Eligible<\/span><b>2/.test(doneHtml) && /<summary><span>Winners<\/span><b>2/.test(doneHtml));
check('done card: winners list open by default, others collapsed', /<details class="sd-names-wrap" open><summary><span>Winners/.test(doneHtml) && /<details class="sd-names-wrap"><summary><span>Eligible/.test(doneHtml));
check('done card: late payer flagged, names escaped, seed + verified shown', doneHtml.includes('after cutoff') && doneHtml.includes('Alice &lt;b&gt;') && !doneHtml.includes('Alice <b>') && doneHtml.includes('Seed 00112233') && doneHtml.includes('verified ✓'));
check('done card: no Run draw now for the public', !pubDoneHtml.includes('runDrawNow'));
check('public done card: winners + video only — no stats, lists, pay times or non-winners', (pubDoneHtml.match(/sd-win-chip/g) || []).length === 2 && pubDoneHtml.includes('sd-video-row') && !pubDoneHtml.includes('sd-stats') && !pubDoneHtml.includes('sd-names-wrap') && !pubDoneHtml.includes('after cutoff') && !pubDoneHtml.includes('Cara') && !pubDoneHtml.includes('Dan') && pubDoneHtml.includes('Automatic draw · 2 in the draw'));
const pendView = SD.viewOf({ date: '2026-09-07', drawAt: MON_AT, day: rec ? { entries: { a: { playerId: 'a', name: 'Alice', present: true, paid: true, payment: { paidAt: MON_AT - 60000 } } } } : null, lineup: [] }, null, MON_AT - 3600000, { winners: 2 });
const pendHtml = sdCardHtml(pendView, true);
const pubPendHtml = sdCardHtml(pendView, false);
check('public pending card: count + pay-before only, no names', !pubPendHtml.includes('sd-names-wrap') && !pubPendHtml.includes('sd-stats') && !pubPendHtml.includes('Alice') && pubPendHtml.includes('1 in the draw so far · Pay before Fri 11 Sep · 9:00 AM'));
check('pending card: "Eligible so far" open, status Pending, pay-before hint', /<details class="sd-names-wrap" open><summary><span>Eligible so far/.test(pendHtml) && pendHtml.includes('>Pending<') && pendHtml.includes('Pay before Fri 11 Sep · 9:00 AM'));
const dueView = SD.viewOf({ date: '2026-09-07', drawAt: MON_AT, day: null, lineup: [{ id: 'a', name: 'Alice' }] }, null, MON_AT + 1000, { winners: 2 });
check('due + pending card in admin mode shows Run draw now; public does not', sdCardHtml(dueView, true).includes("runDrawNow('2026-09-07')") && !sdCardHtml(dueView, false).includes('runDrawNow') && sdCardHtml(dueView, true).includes('Draw pending'));

console.log(`\nsession draw ui: ${pass} passed, ${fail} failed`);
// ── admin Test draw (dry run) + public page retry ──
check('admin Test draw button + panel', html.includes('onclick="runTestDraw()"') && html.includes('id="sdTestPanel"'));
check('runTestDraw is a pure dry run: SessionDraw.testDrawResult, never apiPost', fn('runTestDraw').includes('SessionDraw.testDrawResult(') && !fn('runTestDraw').includes('apiPost') && fn('runTestDraw').includes('sdAdminWinners()'));
check('test draw falls back to the roster when tonight has nobody', fn('runTestDraw').includes('state.roster'));
check('test cards: badge, "not saved" footer, test video source', fn('sdCardHtml').includes("v.test ? 'test'") && fn('sdCardHtml').includes('Test draw · not saved') && fn('sdFindSource').includes("kind === 'test'"));
check('public page retries a failed load once, then offers Try again', fn('loadDrawPage').includes('sdRetried') && fn('loadDrawPage').includes('onclick="loadDrawPage(false)"'));

process.exit(fail ? 1 : 0);
