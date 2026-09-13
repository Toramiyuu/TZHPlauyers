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
check('sub-tab order + names match the public page: Session draw · Monthly draw · Shuttlecock draw', (() => { const a = html.indexOf('data-sub="weekly" onclick="setLuckyTab(\'weekly\')">Session draw<'); const b = html.indexOf('data-sub="monthlylucky" onclick="setLuckyTab(\'monthlylucky\')">Monthly draw<'); const c = html.indexOf('data-sub="monthly" onclick="setLuckyTab(\'monthly\')">Shuttlecock draw<'); return a > 0 && b > a && c > b; })());
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
check('prize rows: photo button, name input, reorder, remove; hidden file input', html.includes('id="mlPrizePhotoInput" type="file" accept="image/*"') && fn('renderMonthlyPrizes').includes('pickMonthlyPrizePhoto(') && fn('renderMonthlyPrizes').includes('setMonthlyPrizeName(') && fn('renderMonthlyPrizes').includes('moveMonthlyPrize(') && fn('renderMonthlyPrizes').includes('removeMonthlyPrize('));
check('photos are compressed client-side (fit 480, JPEG, size-capped) and validated before save', fn('compressPrizePhoto').includes('const max = 480') && fn('compressPrizePhoto').includes("toDataURL('image/jpeg'") && fn('compressPrizePhoto').includes('MonthlyLucky.MAX_PHOTO_BYTES') && fn('monthlyPrizePhotoPicked').includes('MonthlyLucky.isPhoto(photo)'));
check('Save prizes posts the whole ordered list and refuses empty names', fn('saveMonthlyPrizes').includes("action: 'setMonthlyPrizes', prizes: list") && fn('saveMonthlyPrizes').includes('Every prize needs a name'));
check('a background refresh never wipes unsaved prize edits', fn('loadMonthlyAdmin').includes('if (!mlPrizeDirty) mlPrizeDraft ='));
check('typing a prize name does not re-render (keeps focus)', !fn('setMonthlyPrizeName').includes('renderMonthlyPrizes()'));
check('prize rows: quantity (1..99 number) + description inputs, wired without re-render', fn('renderMonthlyPrizes').includes('setMonthlyPrizeQty(') && fn('renderMonthlyPrizes').includes('setMonthlyPrizeDesc(') && fn('renderMonthlyPrizes').includes('type="number" inputmode="numeric" min="\' + MonthlyLucky.MIN_PRIZE_QTY') && fn('renderMonthlyPrizes').includes('maxlength="\' + MonthlyLucky.MAX_PRIZE_DESC') && !fn('setMonthlyPrizeQty').includes('renderMonthlyPrizes()') && !fn('setMonthlyPrizeDesc').includes('renderMonthlyPrizes()'));
check('Save prizes sends qty (blank = 1) + trimmed desc and refuses a bad quantity', fn('saveMonthlyPrizes').includes('MonthlyLucky.DEFAULT_PRIZE_QTY : Number(p.qty)') && fn('saveMonthlyPrizes').includes("desc: String(p.desc || '').trim()") && fn('saveMonthlyPrizes').includes('MonthlyLucky.isPrizeQty(p.qty)'));
check('prize drafts (load + save + add) keep qty/desc', fn('loadMonthlyAdmin').includes('.map(mlPrizeRow)') && fn('saveMonthlyPrizes').includes('.map(mlPrizeRow)') && fn('mlPrizeRow').includes('MonthlyLucky.isPrizeQty(Number(p.qty))') && fn('addMonthlyPrize').includes("qty: MonthlyLucky.DEFAULT_PRIZE_QTY, desc: ''"));
check('helper + help drawer explain the place picker, quantity and description',
  html.includes('Each prize says which place it <b>goes to</b>') && html.includes('that winner takes both')
  && html.includes('Set a quantity to give several of the <em>same</em> item') && html.includes('Each prize has a <b>quantity</b>'));

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
  fn('renderMonthlyPrizes').includes('setMonthlyPrizePlace') && fn('renderMonthlyPrizes').includes('mlPlaceOptions(MonthlyLucky.placeOf(p, i))')
  && fn('renderMonthlyPrizes').includes("'<span class=\"ml-win-rank\">' + MonthlyLucky.placeOf(p, i)"));
check('prize editor: warns when a prize points past the last winner',
  fn('renderMonthlyPrizes').includes('ml-prize-warn') && fn('renderMonthlyPrizes').includes('mlWinnerCount()'));
check('mlOrdinal reads 1st/2nd/3rd/4th and the teens', (() => {
  const f = new Function(fn('mlOrdinal') + '; return mlOrdinal;')();
  return f(1) === '1st' && f(2) === '2nd' && f(3) === '3rd' && f(4) === '4th' && f(11) === '11th' && f(12) === '12th' && f(13) === '13th';
})());
check('mlPlaceOptions offers every place up to the winner count and selects the current one', (() => {
  const f = new Function('mlWinnerCount', 'mlOrdinal', fn('mlPlaceOptions') + '; return mlPlaceOptions;')(() => 3, (n) => n + 'x');
  const html = f(2);
  return (html.match(/<option/g) || []).length === 3 && html.includes('value="2" selected');
})());
check('mlPlaceOptions keeps a place parked beyond the winner count', (() => {
  const f = new Function('mlWinnerCount', 'mlOrdinal', fn('mlPlaceOptions') + '; return mlPlaceOptions;')(() => 2, (n) => n + 'x');
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
check('public prize tiles: label with qty, a ×N badge on the picture, the description under it', fn('renderPublicMonthly').includes('nameOf: MonthlyLucky.prizeLabel') && fn('dhPrizeStripHtml').includes('ml-tile-qty') && fn('dhPrizeStripHtml').includes("p.desc ? '<small>' + escHtml(p.desc) + '</small>'"));
check('replay lookup knows monthly + shuttle sources', fn('sdFindSource').includes("kind === 'monthly'") && fn('sdFindSource').includes('DrawVideo.sourceFromMonthly(v)') && fn('sdFindSource').includes("kind === 'shuttle'") && fn('sdFindSource').includes('DrawVideo.sourceFromShuttlecock(e)'));
check('member widget shows points-to-threshold progress', fn('renderMyDraw').includes('Points this month') && fn('renderMyDraw').includes('MonthlyLucky.isThreshold('));

// ── Shuttlecock draws can record ──
check('Shuttlecock drawPrize stores the ballot pool on each result', fn('drawPrize').includes('pool: [...new Set(ballot.map(p => p.name))]'));
check('Shuttlecock winners list + past-month modal offer the replay', fn('renderMonthlyResults').includes("sdVideoRowHtml('shuttle', live.key, true)") && fn('openMdHist').includes("sdVideoRowHtml('shuttle', ent.key, true)"));
check('Shuttlecock draws are OFF the session record: own page, own month list', !fn('sdListItems').includes("kind: 'shuttle'") && !fn('renderDrawList').includes('shCardHtml') && !fn('renderDrawCalendar').includes('shuttleDrawEntries()') && !html.includes('.sdc-dot.sh{')
  && html.includes('id="drawPageShuttle"') && fn('renderPublicShuttle').includes('shuttleDrawEntries()') && fn('renderPublicShuttle').includes('shCardHtml(e)'));
const shFn = new Function('escHtml', 'SessionDraw', 'ordinalLbl', 'DrawVideo', 'sdVideoRowHtml', 'window', fn('shCardHtml') + '\nreturn shCardHtml;')(ctx.escHtml, SD, (n) => n + 'th', require('../public/draw-video.js'), ctx.sdVideoRowHtml, { DrawVideo: require('../public/draw-video.js') });
const shCard = shFn({ date: '2026-09-20', at: Date.UTC(2026, 8, 20, 12, 0), key: 'shuttle:2026-09:live', label: 'September 2026', live: true, pool: ['Al', 'Bo'], winners: [{ rank: 1, name: 'Bo', prize: 'Tube', pool: ['Al', 'Bo'] }] });
check('shuttle card: title, month, winner chip with prize, replay row', shCard.includes('Shuttlecock Draw · September 2026') && shCard.includes('>Bo<small>Tube</small>') && shCard.includes('data-kind="shuttle" data-key="shuttle:2026-09:live"'));

console.log('monthly lucky ui: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
