#!/usr/bin/env node
/* Static source assertions for the Monthly draws UI in public/index.html (same
 * style as test-session-draw-ui.js): the sub-tab + panel exist and are wired,
 * the settings/prizes/pool/record controls post the right actions, the shared
 * month card renders winners with prizes + replay, the public page has the
 * monthly section, the Shuttlecock draw stores its pool and offers a replay,
 * and the calendar/list know the third card kind. Also evaluates the pure card
 * renderer against a fixture so the markup contract is checked, not just grepped. */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SD = require('../public/session-draw.js');
const ML = require('../public/monthly-lucky.js');

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
check('monthly-lucky.js is loaded after session-draw.js (it borrows the shuffle)', html.indexOf('<script src="/session-draw.js"></script>') < html.indexOf('<script src="/monthly-lucky.js"></script>') && html.indexOf('<script src="/monthly-lucky.js"></script>') < html.indexOf('<script src="/draw-video.js"></script>'));
check('sub-tab order + names match the public page: Session draw · Monthly draw', (() => { const a = html.indexOf('data-sub="weekly" onclick="setLuckyTab(\'weekly\')">Session draw<'); const b = html.indexOf('data-sub="monthlylucky" onclick="setLuckyTab(\'monthlylucky\')">Monthly draw<'); return a > 0 && b > a && !/data-sub="monthly"/.test(html); })());
check('panel exists and starts hidden', /<div class="ld-sub" data-sub="monthlylucky" style="display:none">/.test(html));
check('setLuckyTab + setAdminTab render the monthly admin', fn('setLuckyTab').includes("if (sub === 'monthlylucky') { renderMonthlyLuckyAdmin(); }") && fn('setAdminTab').includes("if (currentLuckyTab === 'monthlylucky') renderMonthlyLuckyAdmin()"));
check('poll only refreshes the light pool list while the tab is open', fn('poll').includes("currentLuckyTab === 'monthlylucky') renderMonthlyPool()") && !fn('poll').includes('loadMonthlyAdmin'));
check('help drawer + audit labels cover the feature', /Lucky Draw &mdash; Monthly draws<\/summary>/.test(html) && html.includes("'monthlyLucky.close': 'Month closed — points reset'") && html.includes("'monthlyLucky.draw':"));

// ── settings card ──
check('automatic switch is a real switch posting setMonthlySettings', /id="mlAutoToggle" type="button" role="switch"/.test(html) && fn('toggleMonthlyAuto').includes('saveMonthlySettings({ auto: !s.auto }') && fn('saveMonthlySettings').includes("action: 'setMonthlySettings'"));
check('winners + points-needed steppers validate with the shared module', html.includes('id="mlWinnersInput"') && html.includes('id="mlThresholdInput"') && fn('setMonthlyWinners').includes('MonthlyLucky.isWinnersCount(') && fn('setMonthlyThreshold').includes('MonthlyLucky.isThreshold(') && html.includes('onclick="stepMonthlyThreshold(-5)"'));
check('how-it-works copy comes from the shared module', fn('renderMonthlySettings').includes('MonthlyLucky.howItWorksText(s)'));
check('"Open public page" opens the Monthly Draw page itself', html.includes('onclick="openDrawPage(\'monthly\')"') && fn('openDrawPage').includes('drawGo(section === undefined ? drawViewFromHash() : section)') && fn('drawGo').includes('DrawHub.isKind(view)'));

// ── prizes ──
check('prize rows: photo button, name input, reorder, remove; one hidden file input for both draws', html.includes('id="mlPrizePhotoInput" type="file" accept="image/*"') && (html.match(/id="mlPrizePhotoInput"/g) || []).length === 1 && fn('renderPrizeEditor').includes('pickPrizePhoto(') && fn('renderPrizeEditor').includes('setPrizeName(') && fn('renderPrizeEditor').includes('movePrize(') && fn('renderPrizeEditor').includes('removePrize('));
check('photos are compressed client-side (fit 480, JPEG, size-capped) and validated before save', fn('compressPrizePhoto').includes('const max = 480') && fn('compressPrizePhoto').includes("toDataURL('image/jpeg'") && fn('compressPrizePhoto').includes('SessionDraw.MAX_PHOTO_BYTES') && fn('prizePhotoPicked').includes('SessionDraw.isPhoto(photo)'));
check('Save prizes posts the whole ordered list to that draw\u2019s action and refuses empty names', fn('savePrizes').includes('action: own.action, prizes: list') && fn('savePrizes').includes('Every prize needs a name') && /monthly: \{ box: 'mlPrizes'[^}]*action: 'setMonthlyPrizes'/.test(html) && /session: \{ box: 'sdPrizes'[^}]*action: 'setDrawPrizes'/.test(html));
check('a background refresh never wipes unsaved prize edits', fn('loadMonthlyAdmin').includes('if (!prizeDirty.monthly) prizeDrafts.monthly =') && fn('sdSeedPrizeDraft').includes('prizeDirty.session'));
check('typing a prize name does not re-render (keeps focus)', !fn('setPrizeName').includes('renderPrizeEditor('));
check('prize rows: quantity (1..99 number) + description inputs, wired without re-render', fn('renderPrizeEditor').includes('setPrizeQty(') && fn('renderPrizeEditor').includes('setPrizeDesc(') && fn('renderPrizeEditor').includes('type="number" inputmode="numeric" min="\' + SessionDraw.MIN_PRIZE_QTY') && fn('renderPrizeEditor').includes('maxlength="\' + SessionDraw.MAX_PRIZE_DESC') && !fn('setPrizeQty').includes('renderPrizeEditor(') && !fn('setPrizeDesc').includes('renderPrizeEditor('));
check('Save prizes sends qty (blank = 1) + trimmed desc and refuses a bad quantity', fn('savePrizes').includes('SessionDraw.DEFAULT_PRIZE_QTY : Number(p.qty)') && fn('savePrizes').includes("desc: String(p.desc || '').trim()") && fn('savePrizes').includes('SessionDraw.isPrizeQty(p.qty)'));
check('prize drafts (load + save + add) keep qty/desc', fn('loadMonthlyAdmin').includes('.map(prizeRow)') && fn('savePrizes').includes('.map(prizeRow)') && fn('prizeRow').includes('SessionDraw.isPrizeQty(Number(p.qty))') && fn('addPrize').includes("qty: SessionDraw.DEFAULT_PRIZE_QTY, desc: ''"));
check('helper + help drawer explain the place picker, quantity and description',
  html.includes('Each prize says which place it <b>goes to</b>') && html.includes('that winner takes both')
  && html.includes('Set a quantity to give several of the <em>same</em> item') && html.includes('Each prize has a <b>quantity</b>'));

check('the prize photos are named as the Lucky Draw hub picture, where they are edited',
  html.includes('class="admin-helper-text mlp-photo-note"') && html.includes('take turns as the big picture')
  && html.includes('onclick="openDrawPage(\'hub\')"'));

// ── pool + manual draw ──
check('Pull button posts pullMonthlyPool and shows the threshold in its label', fn('pullMonthlyPool').includes("action: 'pullMonthlyPool'") && fn('renderMonthlySettings').includes("'Pull players with ' + s.threshold + '+ points'"));
check('pool rows can be removed / put back via setMonthlyPoolRemoved', fn('renderMonthlyPool').includes('setMonthlyPoolRemoved(') && fn('setMonthlyPoolRemoved').includes("action: 'setMonthlyPoolRemoved', playerId: id, removed: !!removed"));
check('stale-pool hint when players crossed the line after the pull', fn('renderMonthlyPool').includes('MonthlyLucky.poolStaleIds(') && fn('renderMonthlyPool').includes('pull again to include them'));
check('Run draw now uses an inline confirm (no native dialogs) and guards double taps', fn('askRunMonthlyDraw').includes('renderMonthlyConfirm()') && fn('renderMonthlyConfirm').includes('Yes, draw now') && fn('runMonthlyDrawNow').includes("action: 'runMonthlyDraw', month") && fn('runMonthlyDrawNow').includes('mlBusy.has(month)') && !/\b(alert|confirm|prompt)\(/.test(fn('askRunMonthlyDraw') + fn('runMonthlyDrawNow') + fn('pullMonthlyPool')));
check('admin list loads via getMonthlyDraws and surfaces a closed month', fn('loadMonthlyAdmin').includes("action: 'getMonthlyDraws'") && fn('loadMonthlyAdmin').includes('res.closedMonths'));

// ── shared month card (evaluated) ──
const ctx = { escHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), SessionDraw: SD, MonthlyLucky: ML, mlBusy: new Set(), sdVideoRowHtml: (k, key) => '<div class="sd-video-row" data-kind="' + k + '" data-key="' + key + '"></div>' };
const cardFn = new Function('escHtml', 'SessionDraw', 'MonthlyLucky', 'mlBusy', 'sdVideoRowHtml', fn('mlWinnersHtml') + '\n' + fn('mlCardHtml') + '\nreturn mlCardHtml;')(ctx.escHtml, ctx.SessionDraw, ctx.MonthlyLucky, ctx.mlBusy, ctx.sdVideoRowHtml);
const doneView = { month: '2026-09', label: 'September 2026', status: 'done', method: 'auto', auto: true, drawnAt: Date.UTC(2026, 9, 1, 1, 0), seed: 'abcdef0123456789', verified: true, threshold: 80, winnersWanted: 2, shortfall: false,
  counts: { eligible: 3, winners: 2 }, prizes: [{ id: 'x', name: 'Racket', photo: 'data:image/jpeg;base64,QUJD' }, { id: 'y', name: 'Socks', photo: null }],
  lists: { eligible: [{ id: 'p1', name: 'Alice <b>', points: 120 }, { id: 'p2', name: 'Bob', points: 80 }, { id: 'p3', name: 'Cara', points: 95 }], winners: [{ rank: 1, id: 'p3', name: 'Cara', prizeId: 'x', prize: 'Racket' }, { rank: 2, id: 'p1', name: 'Alice <b>', prizeId: 'y', prize: 'Socks' }] } };
let card = cardFn(doneView, true);
check('done card: label, status, winners with prize + photo, replay row, seed + verified', card.includes('September 2026') && card.includes('>Drawn<') && card.includes('ml-win-name">Cara<') && card.includes('ml-win-prize">Racket<') && card.includes('ml-win-photo') && card.includes('data-kind="monthly" data-key="2026-09"') && card.includes('Seed abcdef01') && card.includes('verified ✓'));
check('done card escapes names and marks winners in the eligible list with points', card.includes('Alice &lt;b&gt;') && !card.includes('Alice <b>') && card.includes('sd-win-tag">Winner<') && card.includes('120 pts'));
const publicCard = cardFn(Object.assign({ live: false }, doneView), false);
check('public card: no points, no eligible list, still winners + replay', !publicCard.includes(' pts') && !publicCard.includes('sd-names-wrap') && publicCard.includes('ml-win-prize">Socks<') && publicCard.includes('data-kind="monthly"'));
const qtyCard = cardFn(Object.assign({}, doneView, { lists: { eligible: doneView.lists.eligible, winners: [{ rank: 1, id: 'p3', name: 'Cara', prizeId: 'x', prize: '2 × Racket', prizeName: 'Racket', qty: 2, desc: 'Yonex Astrox <b>' }] } }), true);
check('done card shows the quantity label and an escaped description line (none when empty)', qtyCard.includes('ml-win-prize">2 × Racket<') && qtyCard.includes('ml-win-desc">Yonex Astrox &lt;b&gt;<') && !card.includes('ml-win-desc'));
const waiting = { month: '2026-09', label: 'September 2026', status: 'pending', auto: false, live: false, closed: true, due: true, drawAt: ML.scheduledDrawAt('2026-09', 8), threshold: 80, winnersWanted: 3, counts: { eligible: 2, winners: 0 }, lists: { eligible: [{ id: 'p1', name: 'Alice', points: 90 }, { id: 'p2', name: 'Bob', points: 85 }], winners: [] }, prizes: [] };
card = cardFn(waiting, true);
check('closed-but-undrawn month (auto off): Waiting for admin + Run draw now', card.includes('>Waiting for admin<') && card.includes("askRunMonthlyDraw('2026-09')") && card.includes('Automatic draw is off'));
card = cardFn(Object.assign({}, waiting, { auto: true }), true);
check('closed-but-undrawn month (auto on): Draw pending in amber', card.includes('sd-status due">Draw pending<'));
card = cardFn({ month: '2026-10', label: 'October 2026', status: 'pending', auto: true, live: true, due: false, drawAt: ML.scheduledDrawAt('2026-10', 8), threshold: 80, winnersWanted: 3, counts: { eligible: 1, winners: 0 }, lists: { eligible: [{ id: 'p1', name: 'Al', points: 99 }], winners: [] }, prizes: [] }, true);
check('live month card: "This month", no Run button (the pool card has it), eligible-so-far foot', card.includes('>This month<') && !card.includes('askRunMonthlyDraw') && card.includes('1 at 80+ points so far'));

// ── public page ──
check('Monthly Draw page is rendered from /api/draws → monthly', html.includes('id="drawPageMonthly"') && fn('renderDrawPage').includes('renderPublicMonthly()') && fn('renderPublicMonthly').includes('sdPublic.monthly') && fn('renderPublicMonthly').includes('dhPrizeStripHtml(m.prizes') && fn('dhPrizeStripHtml').includes('ml-prize-strip'));
// ── one place, several prizes ──
check('prize editor: every row has a "Goes to" place picker and shows that place as its badge',
  fn('renderPrizeEditor').includes('setPrizePlace') && fn('renderPrizeEditor').includes('mlPlaceOptions(SessionDraw.placeOf(p, i), kind)')
  && fn('renderPrizeEditor').includes("'<span class=\"ml-win-rank\">' + SessionDraw.placeOf(p, i)"));
check('prize editor: warns when a prize points past the last winner',
  fn('renderPrizeEditor').includes('ml-prize-warn') && fn('renderPrizeEditor').includes('prizeWinnerCount(kind)'));
check('mlOrdinal reads 1st/2nd/3rd/4th and the teens', (() => {
  const f = new Function(fn('mlOrdinal') + '; return mlOrdinal;')();
  return f(1) === '1st' && f(2) === '2nd' && f(3) === '3rd' && f(4) === '4th' && f(11) === '11th' && f(12) === '12th' && f(13) === '13th';
})());
check('mlPlaceOptions offers every place up to the winner count and selects the current one', (() => {
  const f = new Function('prizeWinnerCount', 'mlOrdinal', fn('mlPlaceOptions') + '; return mlPlaceOptions;')(() => 3, (n) => n + 'x');
  const html = f(2);
  return (html.match(/<option/g) || []).length === 3 && html.includes('value="2" selected');
})());
check('mlPlaceOptions keeps a place parked beyond the winner count', (() => {
  const f = new Function('prizeWinnerCount', 'mlOrdinal', fn('mlPlaceOptions') + '; return mlPlaceOptions;')(() => 2, (n) => n + 'x');
  return (f(5).match(/<option/g) || []).length === 5;
})());
const multiCard = cardFn(Object.assign({}, doneView, { prizes: [{ id: 'x', name: 'Racket', photo: 'data:image/jpeg;base64,QQ==' }, { id: 'y', name: 'Tube', photo: 'data:image/jpeg;base64,Qg==' }],
  lists: { eligible: doneView.lists.eligible, winners: [{ rank: 1, id: 'p3', name: 'Cara', prizeId: 'x', prize: 'Racket + 2 × Tube',
    prizes: [{ id: 'x', label: 'Racket', desc: 'Yonex' }, { id: 'y', label: '2 × Tube', desc: '' }] }] } }), true);
check('winner row lists every prize of that place, each with its own photo',
  (multiCard.match(/ml-win-prize/g) || []).length === 2 && multiCard.includes('>Racket<') && multiCard.includes('>2 × Tube<')
  && (multiCard.match(/class="ml-win-photo"/g) || []).length === 2 && multiCard.includes('ml-win-photos'));
check('a winner row from an older record still renders from the single prize string',
  (cardFn(doneView, true).match(/ml-win-prize/g) || []).length === 2);
check('public prize cards: place badge, how many of it, a ×N badge on the picture, the description under it',
  fn('dhPrizeStripHtml').includes('SessionDraw.placeOf(p, i)') && fn('dhPrizeStripHtml').includes('ml-tile-place')
  && fn('dhPrizeStripHtml').includes(' of these') && fn('dhPrizeStripHtml').includes('ml-tile-qty')
  && fn('dhPrizeStripHtml').includes("p.desc ? '<small>' + escHtml(p.desc) + '</small>'"));
check('a prize with no photo still reads as a card (placeholder, not a blank box)', fn('dhPrizeStripHtml').includes('ml-tile-ph') && fn('dhPrizeStripHtml').includes("' place prize'"));
check('phones page through the prizes: per-card counter + arrow, dots under the strip, swipe keeps up',
  fn('dhPrizeStripHtml').includes('ml-tile-count') && fn('dhPrizeStripHtml').includes('mlPrizeStep(1)')
  && fn('mlPrizeNavHtml').includes('mlPrizeGo(') && fn('dhPrizeStripHtml').includes('onscroll="mlPrizeSync()"')
  && fn('mlPrizeSync').includes('scrollLeft') && fn('mlPrizeStep').includes('% n'));
check('a 30 s background refresh does not jump the carousel back to the first prize', fn('renderPublicMonthly').includes('mlPrizeSync(true)') && fn('mlPrizeSync').includes("mlPrizeGo(Math.min(mlPrizeIdx, tiles.length - 1), true)"));

// ── the page shell: back to the hub, the draw switch, the record calendar ──
check('the head carries the back pill and the Session/Monthly switch',
  html.includes('id="drawBackBtn" onclick="drawBack()"') && html.includes('<span class="dh-back-txt" id="drawBackTxt">')
  && /<div class="dh-pills" id="drawPills"[^>]*>\s*<button type="button" class="dh-pill" role="tab" data-draw="session"/.test(html));
check('the switch is hidden on the hub, where there is nothing to switch between',
  fn('drawGo').includes("pills.style.display = v === 'hub' ? 'none' : ''") && fn('drawGo').includes('page.dataset.view = v'));
check('the Monthly page leads with standing, then prizes, then the record, then the rules',
  /<section class="dh-view dh-page" data-draw="monthly"/.test(html) && html.includes('class="dhp-win" id="drawPageMonthlyPrizes"')
  && html.includes('class="dhp-record ml-sec" id="drawPageMonthly"') && html.includes('class="dhp-how" id="drawPageMonthlyHow"') && html.includes('class="dhp-side"')
  && fn('renderPublicMonthly').includes('big: st.mine') && fn('dhStatusHtml').includes('dh-st-big'));
check('the rules are stated openly on this page, not behind a toggle', fn('dhHowHtml').includes('dh-howcard') && fn('renderPublicMonthly').includes('MonthlyLucky.howItWorksText('));
check('the record has its own calendar — a year of months, not the session day grid',
  fn('renderPublicMonthly').includes("renderMonthlyCalendar(document.getElementById('drawPageMonthlyCal')")
  && fn('renderMonthlyCalendar').includes('MonthlyLucky.monthYearGrid(mlCal.y)') && !fn('renderMonthlyCalendar').includes('DrawVideo.'));
check('picking a month filters the record; Show all clears it', fn('mlCalPick').includes('mlCal.sel = (month && mlCal.sel !== month) ? month : null') && fn('renderPublicMonthly').includes('rest.filter(v => v.month === mlCal.sel)') && fn('renderMonthlyCalendar').includes('mlCalPick(null)'));
check('the record says which months are still to come', fn('renderPublicMonthly').includes('MonthlyLucky.prevMonthKey(') && fn('renderPublicMonthly').includes('and earlier appear here once drawn.'));

// ── month calendar (evaluated) ──
const calFn = (() => {
  const src = fn('renderMonthlyCalendar');
  return (m, cal) => {
    const box = { innerHTML: '' };
    new Function('escHtml', 'MonthlyLucky', 'clockNow', 'mlCal', 'window', src + '\nreturn renderMonthlyCalendar;')(
      ctx.escHtml, ML, () => Date.UTC(2026, 8, 14), cal, { MonthlyLucky: ML })(box, m);
    return box.innerHTML;
  };
})();
const calData = { pointsMonth: '2026-09', months: [
  { month: '2026-09', label: 'September 2026', status: 'pending' },
  { month: '2026-08', label: 'August 2026', status: 'done' },
  { month: '2026-07', label: 'July 2026', status: 'pending' },
] };
let cal = calFn(calData, { y: 2026, sel: null, init: true });
check('calendar draws twelve months of one year with its own nav', (cal.match(/class="sdc-day/g) || []).length === 12 && cal.includes('>2026<') && cal.includes('mlCalShift(-1)') && cal.includes('mlCalShift(1)'));
check('a drawn month is pickable and marked; a month with no draw is disabled', cal.includes("mlCalPick('2026-08')") && cal.includes('<i class="sdc-dot"></i>') && (cal.match(/ disabled/g) || []).length === 10);
check('a month still waiting on its draw is pickable with a hollow mark', cal.includes("mlCalPick('2026-07')") && cal.includes('<i class="sdc-dot wait"></i>'));
check('the running month is flagged, not offered — it has no card yet', cal.includes('this month') && !cal.includes("mlCalPick('2026-09')"));
cal = calFn(calData, { y: 2026, sel: '2026-08', init: true });
check('a picked month shows what is being filtered and how to clear it', cal.includes('sdc-day mo has sel') && cal.includes('Showing August 2026') && cal.includes('mlCalPick(null)') && cal.includes('aria-pressed="true"'));
cal = calFn(calData, { y: 2025, sel: null, init: true });
check('an empty year still draws, with nothing to pick', (cal.match(/class="sdc-day/g) || []).length === 12 && !cal.includes('mlCalPick(\'') && cal.includes('>2025<'));
check('replay lookup knows the monthly source (and no longer the shuttle one)', fn('sdFindSource').includes("kind === 'monthly'") && fn('sdFindSource').includes('DrawVideo.sourceFromMonthly(v)') && !fn('sdFindSource').includes("kind === 'shuttle'"));
check('member widget shows points-to-threshold progress', fn('renderMyDraw').includes('Points this month') && fn('renderMyDraw').includes('MonthlyLucky.isThreshold('));

// ── Shuttlecock draw removed (2026-09): the Monthly draw must be untouched ──
check('the Monthly (points) draw keeps its own admin tab, prizes, pool and record',
  /<div class="ld-sub" data-sub="monthlylucky"/.test(html) && html.includes('id="mlPrizes"') && html.includes('id="mlAdminList"'));
check('no Shuttlecock renderer, state key or CSS dot is left behind',
  !/renderPublicShuttle|shCardHtml|shuttleDrawEntries|drawPageShuttle|state\.monthlyDraw/.test(html) && !html.includes('.sdc-dot.sh{'));
check('the session record still carries its own sessions + quick draws',
  fn('sdListItems').includes("kind: 'session'") && fn('sdListItems').includes("kind: 'manual'") && !fn('sdListItems').includes("kind: 'shuttle'"));

console.log('monthly lucky ui: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
