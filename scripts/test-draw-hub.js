#!/usr/bin/env node
/* The Lucky Draw hub (2026-09-13; Shuttlecock removed 2026-09-14).
 *
 * Part 1 — pure logic in public/draw-hub.js: the countdown, the entry lines that
 *          name each draw's entry rule, each draw's status card and the
 *          "last winner" line on the hub cards. `nowMs` is always injected.
 * Part 2 — the session-draw prize line (public/session-draw.js + the
 *          setDrawSettings handler), which is set independently of the winner
 *          count so saving one never resets the other.
 * Part 3 — static assertions on public/index.html: the hub + both detail views
 *          exist, the router is wired, and no draw's record leaks into another's.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DH = require('../public/draw-hub.js');
const SD = require('../public/session-draw.js');
const D = require('../lib/session-draw.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
function extractFn(name, src) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) return '';
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (!depth) break; } }
  return src.slice(i, j + 1);
}
const fn = (n) => extractFn(n, html);

// ══ 1. pure: draw-hub.js ═════════════════════════════════════════════
const NOW = Date.UTC(2026, 8, 13, 4, 0); // Sun 13 Sep 2026, 12:00 MYT

// ── kinds + entry lines ──
check('two kinds, in hub order', DH.KINDS.join(',') === 'session,monthly');
check('every kind is named', DH.KINDS.every(k => DH.kindName(k).endsWith('Draw')) && DH.kindName('nope') === '');
check('isKind guards the router', DH.isKind('session') && !DH.isKind('hub') && !DH.isKind('') && !DH.isKind(null));
check('every kind states how you get in', DH.entryLine('monthly', { threshold: 80 }) === 'Reach 80 points in a month'
  && DH.entryLine('session') === 'Play and pay a session');
check('the removed Shuttlecock draw is not a kind any more',
  !DH.isKind('shuttlecock') && DH.kindName('shuttlecock') === '' && DH.entryLine('shuttlecock') === ''
  && DH.shuttleStatus === undefined && DH.latestShuttleWin === undefined);
check('entry line falls back when the threshold is unknown', DH.entryLine('monthly') === 'Reach the points target in a month' && DH.entryLine('monthly', { threshold: 0 }).includes('points target'));

// ── countdown ──
check('countdown: days + hours', DH.countdownText(NOW, NOW + 2 * DH.DAY + 14 * DH.HOUR) === '2d 14h');
check('countdown: hours + zero-padded minutes', DH.countdownText(NOW, NOW + 14 * DH.HOUR + 3 * DH.MINUTE) === '14h 03m');
check('countdown: minutes + seconds under the hour', DH.countdownText(NOW, NOW + 12 * DH.MINUTE + 40000) === '12m 40s');
check('countdown: seconds only', DH.countdownText(NOW, NOW + 9000) === '0m 09s');
check('countdown: past due reads "any moment now"', DH.countdownText(NOW, NOW - 5) === 'any moment now' && DH.countdownText(NOW, NOW) === 'any moment now');
check('countdown: no scheduled time -> empty', DH.countdownText(NOW, 0) === '' && DH.countdownText(NOW, null) === '' && DH.countdownText(NOW, 'x') === '');
check('pool line pluralises and hides zero', DH.poolLine(1) === '1 in the draw' && DH.poolLine(12) === '12 in the draw' && DH.poolLine(0) === '' && DH.poolLine(3, 'enrolled') === '3 enrolled');

// ── session status ──
const sessions = [
  { date: '2026-09-13', status: 'pending', drawAt: NOW + 2 * DH.DAY, counts: { eligible: 8 }, lists: { winners: [] } },
  { date: '2026-09-11', status: 'pending', drawAt: NOW - DH.HOUR, counts: { eligible: 5 }, lists: { winners: [] } },
  { date: '2026-09-07', status: 'done', drawnAt: NOW - 2 * DH.DAY, counts: { eligible: 6 }, lists: { winners: [{ id: 'p1', name: 'Ah Sheng' }, { id: 'p2', name: 'Karine' }] } },
  { date: '2026-09-04', status: 'done', drawnAt: NOW - 5 * DH.DAY, counts: { eligible: 4 }, lists: { winners: [{ id: 'p3', name: 'Boon Chuan' }] } },
];
check('nextSession prefers the earliest draw still ahead', DH.nextSession(sessions, NOW).date === '2026-09-13');
check('nextSession falls back to the most recent overdue one', DH.nextSession(sessions.slice(1), NOW).date === '2026-09-11');
check('nextSession ignores drawn sessions and junk', DH.nextSession(sessions.filter(s => s.status === 'done'), NOW) === null && DH.nextSession(null, NOW) === null);

const sdView = { sessions, winnersPerDraw: 2, sessionPrize: 'A tube of shuttlecocks' };
let st = DH.sessionStatus(sdView, null, NOW);
check('sessionStatus: next night, pool, prize, winners', st.date === '2026-09-13' && st.drawAt === NOW + 2 * DH.DAY && st.due === false && st.poolCount === 8 && st.winners === 2 && st.prize === 'A tube of shuttlecocks');
check('sessionStatus: signed out has no personal line', st.mine === null);
check('sessionStatus: overdue night is marked due', DH.sessionStatus({ sessions: sessions.slice(1) }, null, NOW).due === true);
check('sessionStatus: empty payload never throws', (() => { const e = DH.sessionStatus({}, null, NOW); return e.date === '' && e.drawAt === 0 && e.poolCount === 0; })());

const meIn = { weekly: [{ date: '2026-09-13', present: true, paid: true }] };
const meOwing = { weekly: [{ date: '2026-09-13', present: true, paid: false }] };
const meAbsent = { weekly: [{ date: '2026-09-13', present: false, paid: false }] };
check('sessionMine: paid -> in', DH.sessionStatus(sdView, meIn, NOW).mine.tone === 'ok');
check('sessionMine: attended but unpaid -> pay to enter', (() => { const m = DH.sessionStatus(sdView, meOwing, NOW).mine; return m.tone === 'warn' && m.text === 'Pay to enter'; })());
check('sessionMine: marked absent -> not in this draw', DH.sessionStatus(sdView, meAbsent, NOW).mine.tone === 'off');
check('sessionMine: no record for that night yet -> play to enter', (() => { const m = DH.sessionStatus(sdView, { weekly: [] }, NOW).mine; return m.tone === 'wait' && /Play this session/.test(m.text); })());
check('sessionMine: signed in with no upcoming session still gets a line', DH.sessionStatus({ sessions: [] }, meIn, NOW).mine.tone === 'wait');

// ── monthly status ──
const monthly = {
  auto: true, winners: 3, threshold: 80, pointsMonth: '2026-09',
  prizes: [{ id: 'x', name: 'Racket bag', qty: 1 }],
  months: [
    { month: '2026-09', label: 'September 2026', status: 'pending', drawAt: NOW + 18 * DH.DAY, counts: { eligible: 12 }, lists: { winners: [] } },
    { month: '2026-08', label: 'August 2026', status: 'done', drawnAt: NOW - 12 * DH.DAY, counts: { eligible: 9 }, lists: { winners: [{ rank: 1, name: 'Karine' }, { rank: 2, name: 'Ong Yi' }] } },
  ],
};
let ml = DH.monthlyStatus(monthly, 58, NOW);
check('monthlyStatus: live month, scheduled draw, pool', ml.month === '2026-09' && ml.label === 'September 2026' && ml.drawAt === NOW + 18 * DH.DAY && ml.poolCount === 12 && ml.threshold === 80);
check('monthlyStatus: short of the target counts down the points', ml.mine.tone === 'warn' && ml.mine.text === '22 more points to enter' && ml.mine.points === 58 && ml.mine.toGo === 22);
check('monthlyStatus: one point short reads singular', DH.monthlyStatus(monthly, 79, NOW).mine.text === '1 more point to enter');
check('monthlyStatus: at or past the target is in', DH.monthlyStatus(monthly, 80, NOW).mine.tone === 'ok' && DH.monthlyStatus(monthly, 120, NOW).mine.toGo === 0);
check('monthlyStatus: signed out has no personal line', DH.monthlyStatus(monthly, null, NOW).mine === null);
check('monthlyStatus: a manual month has nothing to count down to', DH.monthlyStatus(Object.assign({}, monthly, { auto: false }), 58, NOW).drawAt === 0);
check('monthlyStatus: no payload -> null (page shows the not-set-up note)', DH.monthlyStatus(null, 10, NOW) === null);

// ── last winner ──
check('winnerLine: one name, then "+ N more"', DH.winnerLine(['Ah Sheng']) === 'Ah Sheng' && DH.winnerLine(['Ah Sheng', 'Karine']) === 'Ah Sheng + 1 more' && DH.winnerLine(['A', 'B', 'C']) === 'A + 2 more');
check('winnerLine: blanks are dropped', DH.winnerLine(['', '  ', 'Bo']) === 'Bo' && DH.winnerLine([]) === '' && DH.winnerLine(null) === '');
check('latestSessionWin: newest drawn night only', (() => { const w = DH.latestSessionWin(sessions); return w.date === '2026-09-07' && w.names.join(',') === 'Ah Sheng,Karine'; })());
check('latestSessionWin: nothing drawn yet -> null', DH.latestSessionWin(sessions.filter(s => s.status !== 'done')) === null && DH.latestSessionWin(null) === null);
check('latestMonthlyWin: newest closed month', DH.latestMonthlyWin(monthly).names.join(',') === 'Karine,Ong Yi' && DH.latestMonthlyWin({ months: [] }) === null);
// ══ 2. the session-draw prize line ═══════════════════════════════════
check('prizeOf trims, collapses whitespace and clamps', SD.prizeOf({ prize: '  A tube   of shuttles ' }) === 'A tube of shuttles'
  && SD.prizeOf({ prize: 'x'.repeat(200) }).length === SD.MAX_PRIZE_LEN
  && SD.prizeOf({ prize: 42 }) === '' && SD.prizeOf({}) === '' && SD.prizeOf(null) === '');

(async () => {
  const opts = (nowMs) => ({ store: D.memoryDrawStore(), nowMs, seedFn: () => 'a'.repeat(32), offsetHours: 8 });
  const fresh = () => ({ sessionDate: '2026-09-13', sessions: {}, attendance: {}, roster: [], audit: [], drawSettings: { winners: 2, prize: '' } });
  const act = (s, body) => D.handleSessionDrawAdminAction(s, Object.assign({ action: 'setDrawSettings' }, body), opts(NOW));

  let s = fresh();
  let r = await act(s, { prize: '  A tube of shuttlecocks  ' });
  check('setDrawSettings saves the prize line (trimmed) + audits it', r.status === 200 && r.changed && s.drawSettings.prize === 'A tube of shuttlecocks'
    && s.audit[0].action === 'draw.settings' && s.audit[0].target.id === 'prize' && s.audit[0].newValue === 'A tube of shuttlecocks');
  check('prize alone does NOT reset the winner count', s.drawSettings.winners === 2);
  r = await act(s, { winners: 4 });
  check('winners alone does NOT clear the prize line', r.status === 200 && s.drawSettings.winners === 4 && s.drawSettings.prize === 'A tube of shuttlecocks');
  r = await act(s, { prize: 'A tube of shuttlecocks' });
  check('same prize again -> unchanged, no second audit row', r.body.unchanged === true && r.changed === false && s.audit.filter(a => a.target.id === 'prize').length === 1);
  r = await act(s, { prize: '' });
  check('empty prize clears the line', r.status === 200 && s.drawSettings.prize === '');
  r = await act(s, { prize: 'x'.repeat(SD.MAX_PRIZE_LEN + 1) });
  check('over-long prize is refused, not silently truncated', r.status === 400 && s.drawSettings.prize === '');
  check('non-string prize is refused', (await act(fresh(), { prize: { a: 1 } })).status === 400);
  check('a body with neither key is refused', (await act(fresh(), {})).status === 400);
  r = await act(fresh(), { winners: 99, prize: 'ok' });
  check('an invalid winner count rejects the whole write', r.status === 400);

  // buildDrawsView carries the prize to the public page
  const st2 = fresh(); st2.drawSettings = { winners: 3, prize: 'Grip + socks' };
  const view = await D.buildDrawsView(st2, D.memoryDrawStore(), { nowMs: NOW, offsetHours: 8 });
  check('GET /api/draws payload carries winnersPerDraw + sessionPrize', view.winnersPerDraw === 3 && view.sessionPrize === 'Grip + socks');

  // ══ 3. static wiring ═══════════════════════════════════════════════
  check('draw-hub.js is loaded as a UMD lib after draw-video.js', html.indexOf('<script src="/draw-video.js"></script>') < html.indexOf('<script src="/draw-hub.js"></script>'));
  check('hub container + both detail sections exist', html.includes('id="drawHub"') && html.includes('id="drawDetail"')
    && /<section class="dh-view[^"]*" data-draw="session"/.test(html) && /<section class="dh-view[^"]*" data-draw="monthly"/.test(html)
    && !/data-draw="shuttlecock"/.test(html));
  check('two pills, one per draw, in hub order', (() => {
    const a = html.indexOf('class="dh-pill" role="tab" data-draw="session"'), b = html.indexOf('class="dh-pill" role="tab" data-draw="monthly"');
    return a > 0 && b > a;
  })());
  check('one head chevron, one level up: out of the page from the hub, back to it from a draw', (() => {
    const b = fn('drawBack');
    return html.includes('id="drawBackBtn" onclick="drawBack()"') && b.includes('closeDrawPage()') && b.includes("drawGo('hub')")
      && fn('drawGo').includes("backTxt.textContent = v === 'hub' ? 'Court display' : 'All draws'");
  })());
  check('drawGo toggles views + pills and is guarded by DrawHub.isKind', fn('drawGo').includes('DrawHub.isKind(view)') && fn('drawGo').includes('.dh-view') && fn('drawGo').includes('.dh-pill'));
  check('per-draw deep links: #draw, #draw/session, #draw/monthly', fn('drawHashFor').includes("'#draw/' + view") && fn('drawViewFromHash').includes('DrawHub.isKind(m[1])') && fn('openDrawPage').includes('drawViewFromHash()'));
  check('renderDrawPage dispatches one view at a time', (() => {
    const f = fn('renderDrawPage');
    return f.includes("drawView === 'hub'") && f.includes('renderDrawHub()') && f.includes('renderSessionDraw()') && f.includes('renderPublicMonthly()');
  })());
  check('header renames itself per draw', fn('renderDrawHeader').includes('DrawHub.kindName(drawView)') && fn('renderDrawHeader').includes('DrawHub.entryLine(drawView'));
  check('both hub cards lead the same way: the big countdown, then the prize in words', (() => {
    const f = fn('renderDrawHub'), sc = fn('dhSessionCardHtml'), mc = fn('dhMonthlyCardHtml');
    const leads = (x) => x.includes('dhc-hero-count') && x.includes('data-draw-at="') && x.includes("<span>to go</span>")
      && x.indexOf('dhc-hero-count') < x.indexOf('dhPrizeListHtml');
    return f.includes('dhSessionCardHtml(sd)') && f.includes('dhMonthlyCardHtml(ml)')
      && leads(sc) && leads(mc) && sc.includes('dhPrizeListHtml(prizes)') && mc.includes('dhPrizeListHtml(ml.prizes)');
  })());
  check('hub cards carry the entry line, the pool, the personal standing, the last winner and the winner count', (() => {
    const shell = fn('dhCardHtml'), sc = fn('dhSessionCardHtml'), mc = fn('dhMonthlyCardHtml');
    return shell.includes('DrawHub.entryLine(kind') && shell.includes('drawGo(') && sc.includes('dhPoolChip(') && sc.includes('dhLastChip(')
      && sc.includes('dhWinnersChip(') && sc.includes('dhMineRowHtml(mine)') && sc.includes('SessionDraw.fmtSessionDate(st.date)') && mc.includes('dhMineRowHtml(ml.mine)') && mc.includes('dhWinnersChip(');
  })());
  check('no picture rides the hub: no photo hero, no rotation timer', (() => {
    const sc = fn('dhSessionCardHtml'), mc = fn('dhMonthlyCardHtml'), list = fn('dhPrizeListHtml');
    return !html.includes('dhHeroPhotoHtml') && !html.includes('dhHeroTimer') && !html.includes('dhc-shot')
      && !sc.includes('<img') && !mc.includes('<img') && !list.includes('<img') && !list.includes('p.photo');
  })());
  check('the prize line names every place, quantity and all', (() => {
    const f = fn('dhPrizeListHtml');
    return f.includes('SessionDraw.placeOf(p, i)') && f.includes('SessionDraw.prizeLabel(p)') && f.includes('mlOrdinal(x.place)')
      && f.includes("if (!list.length) return ''");
  })());
  check('a session with no listed prizes falls back to the admin one-liner',
    fn('dhSessionCardHtml').includes("prizes.length ? dhPrizeListHtml(prizes) : dhPrizeLineHtml(st.prize)"));
  check('the hub greets a signed-in member by name', fn('renderDrawHeader').includes('acctSession.name') && html.includes('id="drawWhoami"'));
  check('a month with the automatic draw off says who runs it instead of counting down',
    fn('dhMonthlyCardHtml').includes("ml.drawAt ? 'Next draw' : 'This month'") && fn('dhMonthlyCardHtml').includes('Drawn by the admin when the month closes'));
  check('the points line belongs to the member, not to a stranger reading the hub',
    fn('dhMonthlyCardHtml').includes('if (ml.mine)') && fn('dhMonthlyCardHtml').includes('points this month') && !fn('dhMonthlyCardHtml').includes("'Reach ' + ml.threshold"));
  check('countdowns re-time in place every second while open', fn('drawTick').includes('[data-draw-at]') && fn('drawTick').includes('DrawHub.countdownText(') && fn('openDrawPage').includes('drawTickTimer = setInterval') && fn('closeDrawPage').includes('clearInterval(drawTickTimer)'));
  check('personal status comes from the token-gated accountDrawInfo, not the poll', fn('drawFetchMine').includes("acctPost('accountDrawInfo'") && !fn('poll').includes('drawFetchMine') && fn('openDrawPage').includes('drawFetchMine()'));
  check('signed-out visitors are offered a sign-in instead of a fake status', fn('dhStatusHtml').includes('!acctSession') && fn('dhStatusHtml').includes('openAuthModal()'));
  check('both pages are the same four blocks: standing, prize, record, rules', (() => {
    const f = fn('renderSessionDraw'), m = fn('renderPublicMonthly');
    const blocks = (s) => ['dhp-status', 'dhp-win', 'dhp-record', 'dhp-how'].every((c) => s.includes(c));
    return f.includes('dhStatusHtml(') && f.includes('dhPrizeCardHtml(st.prize') && m.includes('dhStatusHtml(') && m.includes('dhPrizeStripHtml(')
      && /<section class="dh-view dh-page" data-draw="session"/.test(html) && /<section class="dh-view dh-page" data-draw="monthly"/.test(html)
      && blocks(html) && !html.includes('<details class="dh-how"');
  })());
  check('Session Draw shows the admin-written prize line, with how many winners', fn('dhPrizeCardHtml').includes('Winners get') && fn('dhPrizeCardHtml').includes('sdWinnersLabel(winners)') && fn('renderSessionDraw').includes('dhPrizeCardHtml(st.prize'));
  check('Session Draw leads with the countdown, re-timed in place like every other one', (() => {
    const f = fn('renderSessionDraw');
    return f.includes('const counting = !!st.drawAt && !st.due') && f.includes('data-draw-at="') && f.includes("unit: 'until the draw'")
      && f.includes('DrawHub.countdownText(clockNow(), st.drawAt)') && fn('dhStatusHtml').includes('o.big.html') && fn('drawTick').includes('[data-draw-at]');
  })());
  check('each draw has its own record, none shared', fn('renderSessionDraw').includes("getElementById('drawPageCal')") && fn('renderPublicMonthly').includes('mlCardHtml('));
  check('the session calendar carries sessions + quick draws only', fn('renderDrawCalendar').includes('DrawVideo.indexDraws(sessions, manualDrawEntries())') && !fn('renderDrawCalendar').includes('sdc-dot sh'));
  check('quick draws stay in the session record, clearly labelled', fn('sdListItems').includes("kind: 'manual'") && fn('qdCardHtml').includes('Quick draw') && fn('renderDrawCalendar').includes('Quick draw'));
  check('admin: prize input posts setDrawSettings with prize only', html.includes('id="sdPrizeInput"') && fn('setDrawPrize').includes("action: 'setDrawSettings', prize: next") && !fn('setDrawPrize').includes('winners:'));
  check('admin: prize input is clamped client-side and re-read from drawSettings', fn('setDrawPrize').includes('SessionDraw.MAX_PRIZE_LEN') && fn('sdAdminPrize').includes('adminOps.drawSettings') && fn('renderSessionDrawsAdmin').includes('sdAdminPrize()'));
  check('admin: saving winners no longer wipes the cached prize', fn('setDrawWinners').includes("Object.assign({}, adminOps.drawSettings || {}, { winners: n })"));

  console.log(`\ndraw hub: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
