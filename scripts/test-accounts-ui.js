#!/usr/bin/env node
/* test-accounts-ui — admin Accounts tab: points + payment standing per linked account
 * (2026-09-11, from the organiser's voice note "this person's points, and whether they
 * owe money"). Business logic lives in public/payments.js (test-payments.js); this guards
 * the DOM glue in public/index.html: the row chips reuse the Payments member ledger, the
 * tab loads accounts + ops in one paint, the ledger popup refreshes the rows, and the
 * chip is a real button with a phone-sized hit area and no native dialogs. */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const Payments = require('../public/payments.js');

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

// ── wiring ──
// 2026-09-19 (organiser): a row is name + login code + phone + the last night
// they played, and nothing else. Points, payments, lifetime and the sign-in
// history moved entirely into the Manage profile, so the row stays scannable.
check('the row carries name, code chip, phone and the last-game chip', (() => {
  const f = fn('accountCardHtml');
  return f.includes('${acctCodeChipHtml(a)}') && f.includes('a.phoneDisplay || a.phone')
    && f.includes('${acctLastPlayedHtml(a)}') && f.includes('class="acct-name acct-name-btn"');
})());
check('the old finance / sign-in chips are gone from the row', (() => {
  const f = fn('accountCardHtml');
  return !f.includes('acctFinanceHtml') && !f.includes('Last login') && !f.includes('Failed')
    && !f.includes('Pw changed') && !f.includes('Linked ✓') && !f.includes('Temp pw')
    && !html.includes('function acctFinanceHtml(');
})());
check('only a status worth acting on is badged — Active is the norm, so it is silent', fn('accountCardHtml').includes("a.status === 'active' ? '' : adminStatusBadge(a.status)"));
check('everything dropped from the row still lives in the Manage profile', (() => {
  const p = fn('acctProfileHtml') + fn('acctProfSigninHtml') + fn('acctProfPayHtml');
  return p.includes('Lifetime') && p.includes('Owing') && p.includes('Last login')
    && p.includes('Must change pw') && p.includes('Temp pw');
})());
check('loadAccountsTab fetches accounts + ops together (single paint)', fn('loadAccountsTab').includes("Promise.all([apiPost({ action: 'adminListAccounts' }), loadAdminOps()])") && !fn('loadAccountsTab').includes('loadAdminOps().then'));
check('closing the ledger popup refreshes the Accounts rows', fn('closePmModal').includes("if (currentAdminTab === 'accounts') renderAcctList();"));
check('settling a night from the popup refreshes chips + counters live', fn('pmWrite').includes("if (currentAdminTab === 'accounts') renderAccountsTab();"));
check('Owing counter chip counts linked members with an outstanding balance', fn('renderAcctCounters').includes("chips.push(['Owing', owing, 'bad'])") && fn('renderAcctCounters').includes('.outstanding > 0'));

// ── CSS ──
check('.acct-last is an inline chip in the meta row', html.includes('.acct-last{display:inline-flex;align-items:center;gap:6px}'));
check('"Never" is muted rather than bolded at the reader', html.includes('.acct-last.none{color:var(--muted)}') && html.includes('.acct-last.none b{color:var(--muted);font-weight:600}'));
check('the retired payment chip took its CSS with it', !html.includes('.acct-owe'));

// ── section hygiene ──
const sectionAt = html.indexOf('// ── ADMIN: ACCOUNTS CONTROL TAB');
const sectionEnd = html.indexOf('function toggleInline(', sectionAt);
const section = sectionAt > -1 && sectionEnd > sectionAt ? html.slice(sectionAt, sectionEnd) : '';
check('accounts section found', section.length > 1000);
check('accounts list section has no native confirm/alert/prompt', section.length > 0 && !/\b(confirm|alert|prompt)\(/.test(section));

// ── extracted glue, executed with stubs ──
// "Last game" has to survive three partial sources: attendance rows (only for
// nights the organiser seeded or ended), saved sessions (31 days) and tonight's
// line-up, which is not a saved session yet. Newest of the three wins, and the
// real Night module folds the ghost off-days back onto the night that ran.
const Night = require('../public/night.js');
const factory = new Function('adminOps', 'state', 'todayISO', 'window', 'Night',
  "const WEEKDAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];"
  + "const PM_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];"
  + fn('escHtml') + ';' + fn('weekdayOfISO') + ';' + fn('acctLastPlayedISO') + ';' + fn('acctLastPlayedLabel') + ';'
  + fn('acctLastPlayedHtml') + '; return { acctLastPlayedISO, acctLastPlayedLabel, acctLastPlayedHtml };');
const mk = (ops, st, today) => factory(ops, st, () => today || '2026-09-19', { Night }, Night);
const attendance = {
  // Fri 4 Sep 2026 played, Mon 7 Sep seeded but absent.
  '2026-09-04': { entries: { p1: { name: 'Alex', present: true, paid: true }, p2: { name: 'Bee', present: true, paid: false } } },
  '2026-09-07': { entries: { p1: { name: 'Alex', present: false, paid: false, source: 'regular' } } },
};
const sessions = { '2026-09-11': { players: [{ id: 'p2', name: 'Bee' }] } };
const A = mk({ attendance }, { sessions, sessionDate: '2026-09-18', players: [] });
check('present rows count, seeded-but-absent rows do not', A.acctLastPlayedISO('p1') === '2026-09-04');
check('a saved session beats an older attendance row', A.acctLastPlayedISO('p2') === '2026-09-11');
check('never played reads empty, and an empty player id is safe', A.acctLastPlayedISO('p9') === '' && A.acctLastPlayedISO('') === '' && A.acctLastPlayedISO(null) === '');
const live = mk({ attendance }, { sessions, sessionDate: '2026-09-18', players: [{ id: 'p1', name: 'Alex' }] });
check("tonight's ticked line-up counts before it is ever saved", live.acctLastPlayedISO('p1') === '2026-09-18');
check('an older live date never overrides a newer record', mk({ attendance }, { sessions, sessionDate: '2026-09-01', players: [{ id: 'p2' }] }).acctLastPlayedISO('p2') === '2026-09-11');
// Games are Mon/Fri/Sun. A Saturday record is a ghost the old midnight rollover
// left behind — it belongs to Friday's night, and must never read "Saturday".
const ghost = mk({ attendance: { '2026-08-29': { entries: { p3: { present: true } } } } }, { sessions: {}, players: [] });
check('a ghost Saturday folds back onto the Friday night that ran', ghost.acctLastPlayedISO('p3') === '2026-08-28');
check('and so the chip names a real game night', ghost.acctLastPlayedHtml({ hasPlayer: true, playerId: 'p3' }).includes('Friday, 28 Aug'));
check('a ghost session date folds the same way', mk({ attendance: {} }, { sessions: { '2026-08-29': { players: [{ id: 'p3' }] } }, players: [] }).acctLastPlayedISO('p3') === '2026-08-28');
// The organiser reads nights by their day name — Monday, Friday or Sunday.
check('the label leads with the day name', A.acctLastPlayedLabel('2026-09-04', '2026-09-19') === 'Friday, 4 Sep');
check('Monday and Sunday nights read the same way', A.acctLastPlayedLabel('2026-09-07', '2026-09-19') === 'Monday, 7 Sep' && A.acctLastPlayedLabel('2026-09-13', '2026-09-19') === 'Sunday, 13 Sep');
check('the year only shows when it is not this one', A.acctLastPlayedLabel('2025-12-26', '2026-09-19') === 'Friday, 26 Dec 2025');
check('a junk date never renders a chip', A.acctLastPlayedLabel('', '2026-09-19') === '' && A.acctLastPlayedLabel('not-a-date', '2026-09-19') === '' && A.acctLastPlayedLabel(null, '2026-09-19') === '');
check('a linked player who has played gets the chip', A.acctLastPlayedHtml({ id: 'a1', name: 'Alex', hasPlayer: true, playerId: 'p1' }) === '<span class="acct-last">Last game <b>Friday, 4 Sep</b></span>');
check('a linked player with no record reads Never, muted', A.acctLastPlayedHtml({ id: 'a9', name: 'Zed', hasPlayer: true, playerId: 'p9' }).includes('class="acct-last none">Last game <b>Never</b>'));
check('an unlinked account says so instead of claiming Never', (() => {
  const u = A.acctLastPlayedHtml({ id: 'a3', name: 'Cy', hasPlayer: false, playerId: null });
  return u.includes('Not linked to a player') && !u.includes('Never')
    && A.acctLastPlayedHtml({ id: 'a4', name: 'Di', hasPlayer: true, playerId: null }) === u;
})());
// Before the first poll `state` is null and the ops cache is empty — the row
// still has to paint rather than throw inside renderAcctList.
const cold = mk(null, null);
check('before the first poll nothing is dereferenced', cold.acctLastPlayedISO('p1') === '' && cold.acctLastPlayedHtml({ hasPlayer: true, playerId: 'p1' }).includes('Never'));
check('a malformed attendance day is skipped, not thrown on', mk({ attendance: { '2026-09-04': null, '2026-09-11': { entries: null } } }, { sessions: { '2026-09-13': {} } }).acctLastPlayedISO('p1') === '');
const escaped = fn('accountCardHtml');
check('names never leak markup into the row', escaped.includes('escHtml(a.name') && escaped.includes('${name}'));

// ── member profile (tap a row) ──
// Everything the member can see, editable in one panel. The guard is that each
// control still goes through the shared validated helper rather than a fresh
// raw-state POST, and that the panel can't be wiped mid-edit by a repaint.
check('the row avatar, the name and Manage all open the profile', fn('accountCardHtml').includes('onclick="${pmCall(\'openAcctProfile\', a.id)}"') && (fn('accountCardHtml').match(/openAcctProfile/g) || []).length >= 3);
check('openAcctProfile renders before it shows, and locks the page scroll', fn('openAcctProfile').includes('renderAcctProfile();') && fn('openAcctProfile').indexOf('renderAcctProfile();') < fn('openAcctProfile').indexOf("classList.add('open')") && fn('openAcctProfile').includes("document.body.style.overflow = 'hidden'"));
check('closing restores the scroll and repaints the list behind it', fn('closeAcctProfile').includes("document.body.style.overflow = ''") && fn('closeAcctProfile').includes("if (currentAdminTab === 'accounts') renderAcctList();"));
check('Escape closes the profile with the other overlays', fn('closeOpenOverlays').includes("if (isOpen('acctProfile'))  { closeAcctProfile();  closed = true; }"));
check('the Accounts repaint keeps the open profile in sync', fn('renderAccountsTab').includes('renderAcctProfile();'));
check('a repaint never lands on a field being typed into', fn('renderAcctProfile').includes('body.contains(el)') && fn('renderAcctProfile').includes('/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)'));
check('a deleted account closes its own profile', fn('deleteAccountAdmin').includes('if (acctProfileId === id) closeAcctProfile();'));
check('points edits reuse the validated setRosterPoints helpers', fn('acctProfPoints').includes('setPlayerPoints(pid, value)') && fn('acctProfBump').includes('bumpPlayerPoints(pid, delta)'));
check('name / photo / level / girl / mixed reuse the roster helpers', fn('acctProfName').includes('saveRosterName(pid, value)') && fn('acctProfPhoto').includes('handleRosterPhoto(pid, input)')
  && fn('acctProfLevel').includes('setPlayerLevel(pid, value)') && fn('acctProfGirl').includes('togglePlayerGirl(pid)') && fn('acctProfMixed').includes('togglePlayerMixed(pid)'));
check('every edit repaints the panel with what the server stored', ['acctProfPoints', 'acctProfBump', 'acctProfLevel', 'acctProfGirl', 'acctProfMixed', 'acctProfName', 'acctProfPhoto'].every(n => fn(n).includes('renderAcctProfile()')));
check('the ledger rows are the Payments tap-to-settle rows, not a copy', fn('acctProfPayHtml').includes('pmMemSessHtml(x, m.playerId)'));
check('points section shows the Monthly-draw bar the member sees', fn('acctProfPointsHtml').includes('mlSettings().threshold') && fn('acctProfPointsHtml').includes('In the Monthly draw') && fn('acctProfPointsHtml').includes('more for the draw'));
check('an unlinked account is told to link a player instead of showing zeros', fn('acctProfPointsHtml').includes('Link this account to a roster player'));
check('Copy invite needs a code and copies code + link without a native dialog', fn('copyAcctInvite').includes('if (!a.code)') && fn('copyAcctInvite').includes('navigator.clipboard.writeText(msg)') && !/\b(confirm|alert|prompt)\(/.test(fn('copyAcctInvite')));
check('the delete confirm puts back whichever label the button had', fn('deleteAccountAdmin').includes('btn.dataset.label || btn.textContent') && fn('deleteAccountAdmin').includes('btn.textContent = label;'));
check('the profile markup exists with a dialog role', html.includes('<div id="acctProfile" role="dialog" aria-modal="true"') && html.includes('<div id="acctProfileBody"></div>'));
check('the profile overlay shares the Payments popup shell', html.includes('#pmModal,#acctProfile{display:none;position:fixed') && html.includes('#pmModal.open,#acctProfile.open{display:flex}'));
check('the −/+ point steps are shown in the profile even on a phone', html.includes('.ap-pts .rl-pt-step{display:flex}'));
const profSection = html.slice(html.indexOf('// ── ADMIN: MEMBER PROFILE'), html.indexOf('// ── login codes (admin) ──'));
check('member profile section has no native confirm/alert/prompt', profSection.length > 1000 && !/\b(confirm|alert|prompt)\(/.test(profSection));

console.log(`\naccounts ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
