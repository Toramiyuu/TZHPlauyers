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
check('accountCardHtml renders the finance chips in the meta row', fn('accountCardHtml').includes('${linked}') && fn('accountCardHtml').includes('${acctFinanceHtml(a)}') && fn('accountCardHtml').indexOf('${linked}') < fn('accountCardHtml').indexOf('${acctFinanceHtml(a)}'));
check('acctFinanceHtml reuses the Payments member ledger + tier helper', fn('acctFinanceHtml').includes('Payments.memberSummary(') && fn('acctFinanceHtml').includes('Payments.memberOweLabel(m)') && fn('acctFinanceHtml').includes('tierForPoints(pts)') && fn('acctFinanceHtml').includes('pmRosterPlayer(a.playerId)'));
check('acctFinanceHtml only renders for accounts linked to a roster player', fn('acctFinanceHtml').includes('!a.hasPlayer || !a.playerId') && fn('acctFinanceHtml').includes('!window.Payments'));
check('payment chip is a button that opens the member ledger popup', fn('acctFinanceHtml').includes('<button type="button" class="acct-owe') && fn('acctFinanceHtml').includes("pmCall('openPmMember', a.playerId)"));
check('loadAccountsTab fetches accounts + ops together (single paint)', fn('loadAccountsTab').includes("Promise.all([apiPost({ action: 'adminListAccounts' }), loadAdminOps()])") && !fn('loadAccountsTab').includes('loadAdminOps().then'));
check('closing the ledger popup refreshes the Accounts rows', fn('closePmModal').includes("if (currentAdminTab === 'accounts') renderAcctList();"));
check('settling a night from the popup refreshes chips + counters live', fn('pmWrite').includes("if (currentAdminTab === 'accounts') renderAccountsTab();"));
check('Owing counter chip counts linked members with an outstanding balance', fn('renderAcctCounters').includes("chips.push(['Owing', owing, 'bad'])") && fn('renderAcctCounters').includes('.outstanding > 0'));

// ── CSS ──
check('.acct-owe is a reset button that inherits the chip look', /\.acct-owe\{position:relative;appearance:none;background:none;border:0;padding:0;margin:0;font:inherit;color:inherit;cursor:pointer;display:inline-flex/.test(html));
check('.acct-owe has a phone-sized hit area', html.includes('.acct-owe::after{content:"";position:absolute;inset:-8px}'));
check('owing chip turns red without !important', html.includes('.acct-owe.owe,.acct-owe.owe b{color:var(--red)}') && !/\.acct-owe[^\n]*!important/.test(html));

// ── section hygiene ──
const sectionAt = html.indexOf('// ── ADMIN: ACCOUNTS CONTROL TAB');
const sectionEnd = html.indexOf('function toggleInline(', sectionAt);
const section = sectionAt > -1 && sectionEnd > sectionAt ? html.slice(sectionAt, sectionEnd) : '';
check('accounts section found', section.length > 1000);
check('accounts list section has no native confirm/alert/prompt', section.length > 0 && !/\b(confirm|alert|prompt)\(/.test(section));

// ── extracted glue, executed with stubs ──
// The row also shows the admin-only lifetime total, which reads from the same
// injected adminOps cache — pull those helpers in rather than stubbing them.
const factory = new Function('pmRosterPlayer', 'tierForPoints', 'Payments', 'adminOps', 'state', 'window',
  fn('escHtml') + ';' + fn('pmCall') + ';' + fn('lifetimePointsLoaded') + ';' + fn('lifetimePointsFor') + ';'
  + fn('lifetimePointsLabel') + ';' + fn('acctFinanceHtml') + '; return acctFinanceHtml;');
const attendance = {
  '2026-09-07': { entries: { p1: { name: 'Alex', present: true, paid: false, payment: { fee: 25, tier: '3h', method: null, paidAt: null } } } },
  '2026-09-04': { entries: { p1: { name: 'Alex', present: true, paid: true, payment: { fee: 20, tier: '2h', method: 'cash', paidAt: 1 } } } },
};
const mk = (roster) => factory(
  (pid) => roster.find(r => r.id === pid) || null,
  (pts) => ({ name: pts >= 900 ? 'Gold' : 'Visitor' }),
  Payments, { attendance }, { roster }, { Payments });
const withPts = mk([{ id: 'p1', name: 'Alex', points: 1240 }]);
const owingRow = withPts({ id: 'a1', name: 'Alex', hasPlayer: true, playerId: 'p1' });
check('linked + owing: points with tier, red chip, RM + nights, opens the ledger', owingRow.includes('<span>Points <b>1,240 · Gold</b></span>') && owingRow.includes('class="acct-owe owe"') && owingRow.includes('RM25 · 1 night</b>') && owingRow.includes("onclick=\"openPmMember('p1')\""));
const settledFactory = mk([{ id: 'p2', name: 'Bee', points: 0 }]);
const settledAtt = { '2026-09-04': { entries: { p2: { paid: true, payment: { fee: 20 } } } } };
const settledRow = factory((pid) => ({ id: 'p2', name: 'Bee', points: 0 }), () => ({ name: 'Visitor' }), Payments, { attendance: settledAtt }, { roster: [] }, { Payments })({ id: 'a2', name: 'Bee', hasPlayer: true, playerId: 'p2' });
check('linked + settled: not red, reads Settled', settledRow.includes('class="acct-owe"') && settledRow.includes('Settled</b>') && !settledRow.includes(' owe"') && settledRow.includes('<b>0 · Visitor</b>'));
check('no records yet', settledFactory({ id: 'a2', name: 'Bee', hasPlayer: true, playerId: 'p2' }).includes('No records yet</b>'));
check('unlinked account renders nothing extra', withPts({ id: 'a3', name: 'Cy', hasPlayer: false, playerId: null }) === '' && withPts({ id: 'a4', name: 'Di', hasPlayer: true, playerId: null }) === '');
const missingRoster = factory(() => null, () => ({ name: 'x' }), Payments, { attendance }, { roster: [] }, { Payments })({ id: 'a1', name: 'Alex', hasPlayer: true, playerId: 'p1' });
check('roster player missing: points show a dash, ledger still available', missingRoster.includes('<span>Points <b>&ndash;</b></span>') && missingRoster.includes('RM25 · 1 night'));
const noState = factory(() => { throw new Error('must not be called'); }, () => ({ name: 'x' }), Payments, { attendance }, null, { Payments })({ id: 'a1', name: 'Alex', hasPlayer: true, playerId: 'p1' });
check('before the first poll (state null) the roster is not dereferenced', noState.includes('<b>&ndash;</b>'));
// Lifetime points: admin-only, from the ops cache, never from state.roster.
check('lifetime shows a dash until the ops cache has been fetched', owingRow.includes('Lifetime <b>&ndash;</b>'));
const withLife = factory((pid) => ({ id: 'p1', name: 'Alex', points: 1240 }), () => ({ name: 'Gold' }), Payments,
  { attendance, lifetimePoints: { p1: 3480 } }, { roster: [] }, { Payments })({ id: 'a1', name: 'Alex', hasPlayer: true, playerId: 'p1' });
check('lifetime renders the fetched total, grouped', withLife.includes('Lifetime <b>3,480</b>'));
check('a player with no lifetime entry reads 0, not a dash, once fetched', factory((pid) => ({ id: 'p9', points: 0 }), () => ({ name: 'Visitor' }), Payments,
  { attendance: {}, lifetimePoints: {} }, { roster: [] }, { Payments })({ id: 'a9', name: 'Zed', hasPlayer: true, playerId: 'p9' }).includes('Lifetime <b>0</b>'));
const escaped = withPts({ id: 'a5', name: 'O"Neil <b>', hasPlayer: true, playerId: 'p1' });
check('names never leak markup into the row', !escaped.includes('<b>O"') && !escaped.includes('O"Neil <b>'));

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
