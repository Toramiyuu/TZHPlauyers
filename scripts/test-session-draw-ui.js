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
check('#draw deep link is honoured after the site unlocks', /#draw\(\\\/\|\$\)/.test(fn('sdAfterPoll')) && fn('poll').includes('sdAfterPoll()'));
check('page data comes from /api/draws with the site code, not the 2s poll', fn('fetchPublicDraws').includes("fetch('/api/draws?'") && fn('fetchPublicDraws').includes("localStorage.getItem('siteCode')") && !fn('poll').includes('loadDrawPage'));
check('page refreshes every 30s while open and stops on close', fn('openDrawPage').includes('30000') && fn('closeDrawPage').includes('clearInterval(sdPublicTimer)'));
check('locked response shows a site-code hint instead of an error', fn('loadDrawPage').includes('res.locked') && /site code/.test(fn('loadDrawPage')));
check('how-it-works copy comes from the shared module', fn('renderSessionDraw').includes('SessionDraw.howItWorksText(sdPublic.winnersPerDraw)'));

// ── the page itself (rebuilt 2026-09-14 to match the Monthly page) ──
check('same four blocks as Monthly, in the same order', /<section class="dh-view dh-page" data-draw="session"/.test(html)
  && html.includes('class="dh-status-wrap dhp-status" id="sdStatusCard"') && html.includes('class="dhp-win" id="drawPagePrize"')
  && html.includes('class="dh-howcard dhp-how"') && /<div class="dhp-record">/.test(html));
check('the record (calendar, list, older button) is one block, so it can be a column',
  (() => { const a = html.indexOf('<div class="dhp-record">'), b = html.indexOf('id="drawPageCal"'), c = html.indexOf('id="drawPageMore"'); return a > -1 && a < b && b < c; })());
check('the countdown is the headline number and keeps ticking',
  fn('renderSessionDraw').includes('const counting = !!st.drawAt && !st.due') && fn('renderSessionDraw').includes("unit: 'until the draw'")
  && fn('renderSessionDraw').includes('data-draw-at="') && fn('drawTick').includes('[data-draw-at]'));
check('a due draw drops the countdown instead of counting down from zero', fn('renderSessionDraw').includes("label: st.due ? 'Drawing now' : 'Next draw'") && fn('renderSessionDraw').includes('!st.due'));
check('the prize is its own card with the winner count, and says so when unset',
  fn('renderSessionDraw').includes("getElementById('drawPagePrize')") && fn('dhPrizeCardHtml').includes('sdWinnersLabel(winners)')
  && fn('dhPrizeCardHtml').includes('has not been announced yet') && fn('dhPrizeCardHtml').includes('dh-prize-none'));
// ── prizes (2026-09-15: the same list, editor and cards as the Monthly draw) ──
check('the admin gets the same Prizes card, saving through setDrawPrizes',
  html.includes('id="sdPrizesCard"') && html.includes('class="ml-prizes" id="sdPrizes"') && html.includes('id="sdPrizesSaveBtn"')
  && html.includes("onclick=\"addPrize('session')\"") && html.includes("onclick=\"savePrizes('session')\"")
  && /session: \{ box: 'sdPrizes'[^}]*action: 'setDrawPrizes'/.test(html));
check('the editor seeds from the admin fetch (the only copy with photos), never the poll',
  fn('sdAdminPrizes').includes('sdAdmin.sessionPrizes') && !fn('sdAdminPrizes').includes('state.drawSettings')
  && fn('sdSeedPrizeDraft').includes('prizeDrafts.session = prizes.map(prizeRow)') && fn('sdSeedPrizeDraft').includes('prizeDirty.session')
  && fn('loadAdminDraws').includes('sdSeedPrizeDraft()') && fn('savePrizes').includes('sdAdmin.sessionPrizes ='));
check('the page shows the listed prizes as cards, the one-line prize only while the list is empty',
  fn('renderSessionDraw').includes('dhPrizeCardHtml(st.prize, sdPublic.winnersPerDraw, sdPublic.sessionPrizes)')
  && fn('dhPrizeCardHtml').includes('if (list.length) return head') && fn('dhPrizeCardHtml').includes('dhPrizeStripHtml(list)')
  && fn('dhPrizeCardHtml').includes('has not been announced yet'));
check('the hub card names the prizes in words, the photos stay on the draw page',
  fn('dhSessionCardHtml').includes('sdPublic.sessionPrizes') && fn('dhSessionCardHtml').includes('dhPrizeListHtml(prizes)')
  && !fn('dhSessionCardHtml').includes('dhHeroPhotoHtml') && !html.includes('dhc-hero-photo'));
check('the countdown keeps its panel above the prize line — when, then what for',
  (() => { const f = fn('dhSessionCardHtml'); return f.indexOf('dhc-hero-count') < f.indexOf('dhPrizeListHtml(prizes)'); })());
check('the one-line prize shows only while no prizes are listed', fn('dhSessionCardHtml').includes("prizes.length ? dhPrizeListHtml(prizes) : dhPrizeLineHtml(st.prize)") && fn('dhPrizeLineHtml').includes('Winners get'));
check('nothing on the hub rotates: no slide index, no hero clock', !/dhHeroIdx/.test(html) && !/DH_HERO_MS/.test(html) && !/dhHeroSync/.test(html));
check('both prize carousels are scoped to the view on screen (ids would collide)',
  fn('mlPrizeStripEl').includes("'.dh-view[data-draw=\"' + drawView + '\"] .ml-prize-strip'") && !fn('mlPrizeTiles').includes('getElementById'));
check('a session prize photo never rides the 2 s poll', (() => {
  const st = fs.readFileSync(path.join(__dirname, '..', 'api', 'state.js'), 'utf8');
  return st.includes('SD.litePrizes(draw.prizes)') && st.includes('prizes: SD.prizesOf(current.drawSettings)');
})());

check('the rules are open on the page, not behind a toggle', /<p class="dh-how-body" id="drawPageHow">/.test(html) && !html.includes('<details class="dh-how"'));
check('"My Lucky Draw" links to the public page and no longer claims weekly wins', fn('renderMyDraw').includes('openDrawPage()') && !fn('renderMyDraw').includes('Won!'));

// ── admin sub-tab ──
check('Lucky Draw sub-tab is relabelled "Session draw"', /data-sub="weekly" onclick="setLuckyTab\('weekly'\)">Session draw<\/button>/.test(html));
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
check('help drawer describes the session draw', /Lucky Draw: Session draws/.test(html) && /Run draw now/.test(html));
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
const src = esc + ';' + 'const SessionDraw = arguments[0]; const sdBusy = new Set(); let sdConfirm = null;'
  + "const SD_LIST_KEYS = [['attended', 'Attended'], ['paid', 'Paid'], ['eligible', 'Eligible'], ['winners', 'Winners']];"
  + fn('sdWinnersLabel') + ';' + fn('sdListHtml') + ';' + fn('sdVideoRowHtml') + ';' + fn('sdAsking') + ';' + fn('sdCardHtml')
  + '; return { card: sdCardHtml, ask: (date, kind) => { sdConfirm = date ? { date, kind } : null; } };';
const evaluated = new Function(src)(SD);
const sdCardHtml = evaluated.card;
// Stands in for the admin having tapped "Re-draw" / "Remove result" on that card.
const askAction = evaluated.ask;
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
check('public pending card: count + pay-before only, no names', !pubPendHtml.includes('sd-names-wrap') && !pubPendHtml.includes('sd-stats') && !pubPendHtml.includes('Alice') && pubPendHtml.includes('1 in the draw so far · Pay before Thu 10 Sep · 9:00 AM'));
check('pending card: "Eligible so far" open, status Pending, pay-before hint', /<details class="sd-names-wrap" open><summary><span>Eligible so far/.test(pendHtml) && pendHtml.includes('>Pending<') && pendHtml.includes('Pay before Thu 10 Sep · 9:00 AM'));
const dueView = SD.viewOf({ date: '2026-09-07', drawAt: MON_AT, day: null, lineup: [{ id: 'a', name: 'Alice' }] }, null, MON_AT + 1000, { winners: 2 });
// The date is the jump to that night's money — admin only, never on a test card.
check('admin card heading opens that night in Payments', doneHtml.includes("openPaymentsForNight('2026-09-07')") && doneHtml.includes('class="sd-date sd-date-link"'));
check('a member sees the date as plain text, not a link', !pubDoneHtml.includes('openPaymentsForNight') && pubDoneHtml.includes('<div class="sd-date">'));
// ── redoing a result: Re-draw / Remove result (2026-09-18) ──
check('a drawn card offers Re-draw + Remove result to admins only, both behind an inline confirm',
  doneHtml.includes("askDrawAction('2026-09-07','redraw')") && doneHtml.includes('>Re-draw<')
  && doneHtml.includes("askDrawAction('2026-09-07','remove')") && doneHtml.includes('Remove result') && doneHtml.includes('sd-remove-btn')
  && !doneHtml.includes('redrawResult(') && !doneHtml.includes('removeDrawResult(')
  && !pubDoneHtml.includes('askDrawAction'));
check('each confirm posts its own action, on its own card only', (() => {
  askAction('2026-09-07', 'redraw');
  const redrawing = sdCardHtml(doneView, true);
  const other = sdCardHtml(Object.assign({}, doneView, { date: '2026-09-04' }), true);
  askAction('2026-09-07', 'remove');
  const removing = sdCardHtml(doneView, true);
  askAction(null);
  return redrawing.includes("redrawResult('2026-09-07')") && redrawing.includes('Yes, draw again') && redrawing.includes('askDrawAction(null)')
    && !redrawing.includes('removeDrawResult(')
    && removing.includes("removeDrawResult('2026-09-07')") && removing.includes('Yes, remove it') && !removing.includes('redrawResult(')
    && !other.includes('Yes, draw again') && other.includes("askDrawAction('2026-09-04','redraw')")
    && sdCardHtml(doneView, true).includes("askDrawAction('2026-09-07','redraw')");
})());
check('both actions post through the same guarded shell and reload the list',
  fn('redrawResult').includes("action: 'redraw'") && fn('removeDrawResult').includes("action: 'removeDraw'")
  && fn('sdCardAction').includes('sdBusy.has(date)') && fn('sdCardAction').includes('sdBusy.add(date)')
  && fn('sdCardAction').includes('loadAdminDraws(false)') && fn('sdCardAction').includes('sdConfirm = null'));
check('a re-draw with nobody eligible says so instead of claiming winners', fn('redrawResult').includes('Nobody was eligible'));
check('a pending card explains a removed result instead of promising an automatic draw',
  (() => { const h = sdCardHtml(Object.assign({}, dueView, { removed: true, removedAt: MON_AT + 60000 }), true);
    return h.includes('The earlier result was removed') && !h.includes('may still be on its way') && h.includes("runDrawNow('2026-09-07')"); })());
check('members are told a result was removed, not left staring at an empty night',
  sdCardHtml(Object.assign({}, dueView, { removed: true }), false).includes('The result for this night was removed'));
check('openPaymentsForNight lands on that night, By night, at the top of the tab',
  fn('openPaymentsForNight').includes('pmDate = date') && fn('openPaymentsForNight').includes("pmView = 'night'")
  && fn('openPaymentsForNight').includes("setAdminTab('payments')") && fn('openPaymentsForNight').includes('window.scrollTo')
  && fn('renderPaymentsTab').includes('if (!pmDate) pmDate ='));
check('due + pending card in admin mode shows Run draw now; public does not', sdCardHtml(dueView, true).includes("runDrawNow('2026-09-07')") && !sdCardHtml(dueView, false).includes('runDrawNow') && sdCardHtml(dueView, true).includes('Draw pending'));

// ── the admin "Test draw" dry run is gone (2026-09-18) ──
for (const sym of ['runTestDraw', 'clearTestDraw', 'renderTestDraw', 'sdTestPanel', 'sd-test', 'testDrawResult', 'Test draw', 'sdTest']) {
  check('retired dry run: ' + sym, !html.includes(sym));
}
check('no test-draw branch survives in the card or the video lookup', !fn('sdCardHtml').includes('v.test') && !fn('sdFindSource').includes("'test'") && !fs.readFileSync(path.join(__dirname, '..', 'public', 'draw-video.js'), 'utf8').includes('src.test'));
check('public page retries a failed load once, then offers Try again', fn('loadDrawPage').includes('sdRetried') && fn('loadDrawPage').includes('onclick="loadDrawPage(false)"'));

// ── Shuttlecock Draw REMOVED (2026-09) ──────────────────────────────────
// The admin-run monthly ballot is gone: no sub-tab, no enrolment card, no prize
// board, no public page, no member-facing copy. Stored records are left dormant
// in Redis (see test-state-normalize.js) but must never surface in the UI again.
check('no Shuttlecock sub-tab, enrolment card, prize board or past-month modal',
  !/data-sub="monthly"/.test(html) && !html.includes('Shuttlecock Draw enrolment')
  && !html.includes('mdBoardModal') && !html.includes('mdHistModal') && !html.includes('mdBoardBtn'));
check('no Shuttlecock entry on the public Lucky Draw hub',
  !html.includes('data-draw="shuttlecock"') && !html.includes('drawPageShuttle') && !html.includes('shStatusCard'));
check('the ballot state key is never read in the browser again', !/state\.monthlyDraw|monthlyEligibility/.test(html));
check('no Shuttlecock renderer survives',
  !/function (renderPublicShuttle|shCardHtml|shuttleDrawEntries|publicWinnersHtml|renderMonthlyTab|renderMonthlyElig|openMdBoard|openMdHist)\b/.test(html));
check('the member page no longer claims Shuttlecock enrolment or winners',
  !fn('renderMyDraw').includes('Shuttlecock') && fn('renderMyDraw').includes('Monthly draw'));
// The reveal overlay is SHARED with the manual quick draw, so it stays — but
// under a neutral title, and using the ordinal helper that handles ranks > 3.
check('shared reveal overlay kept, retitled, and rank label fixed',
  html.includes('<div id="pickerTitle">Lucky Draw</div>') && fn('showPickerOverlay').includes("|| 'Lucky Draw'")
  && !/mdRankLbl/.test(html) && fn('showPickerOverlay').includes('ordinalLbl(rank)'));
check('the two remaining draws are intact',
  /data-sub="weekly" onclick="setLuckyTab\('weekly'\)">Session draw</.test(html)
  && /data-sub="monthlylucky" onclick="setLuckyTab\('monthlylucky'\)">Monthly draw</.test(html));
check('the word "shuttlecock" survives only as a prize/points example, never as a draw',
  !/Shuttlecock Draw|Shuttlecock draw|Shuttlecock Lucky Draw|Shuttlecock Prize/.test(html));

console.log(`\nsession draw ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
