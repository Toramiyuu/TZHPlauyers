#!/usr/bin/env node
/* test-payments-ui — per-player session payments: frontend wiring in public/index.html.
 * Business logic lives in public/payments.js (covered by test-payments.js); this guards the
 * DOM glue: the End-of-day button sits in the Courts footer next to Add Round, the Payments
 * tab is wired into every nav surface, the modal closes on Escape, the fee control repaints
 * safely, and the phone-first rules (44px targets, 16px input, no native dialogs) hold. */
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

// ── script include ──
check('payments.js is loaded before the inline app script', html.indexOf('<script src="payments.js"></script>') > -1 && html.indexOf('<script src="payments.js"></script>') < html.lastIndexOf('<script>'));

// ── Courts footer: End of the day bottom-right, next to Add Round Manually ──
const footAt = html.indexOf('class="crt-foot');
const courtsEnd = html.indexOf('<!-- /courts tab -->');
const foot = footAt > -1 ? html.slice(footAt, courtsEnd) : '';
check('Courts footer exists inside the Courts tab', footAt > -1 && footAt < courtsEnd);
check('footer holds Add Round Manually AND End of the day', foot.includes('addEmptyRound()') && foot.includes('id="eodBtn"'));
check('End of the day sits to the right of Add Round', foot.indexOf('addEmptyRound()') < foot.indexOf('id="eodBtn"'));
check('footer status line jumps to the Payments tab', foot.includes('id="eodStatus"') && foot.includes("setAdminTab('payments')"));
check('.crt-foot flex row, right column', /\.crt-foot\{[^}]*justify-content:space-between/.test(html) && /\.crt-foot-end\{[^}]*align-items:flex-end/.test(html));

// ── Payments tab wired into every nav surface ──
check('sidebar nav item', /class="admin-nav-item" data-tab="payments"/.test(html));
check('tab panel', /class="admin-tab-panel" data-tab="payments"/.test(html));
check('More sheet item (mobile)', /class="ams-item" data-tab="payments"/.test(html));
check('ADMIN_TAB_TITLES has Payments', /ADMIN_TAB_TITLES = \{[^}]*payments: 'Payments'/.test(html));
check('ADMIN_MORE_TABS lists payments (More button lights up)', /ADMIN_MORE_TABS = \[[^\]]*'payments'/.test(html));
check('setAdminTab renders + refreshes the tab', fn('setAdminTab').includes("name === 'payments'") && fn('setAdminTab').includes('renderPaymentsTab()') && fn('setAdminTab').includes('loadAdminOps()'));
check('nav badge shows unpaid count', fn('updateAdminNavBadges').includes("setNavBadge('navBadgePayments', unpaid)") && html.includes('id="navBadgePayments"'));
check('help drawer documents Payments', /<summary>Payments<\/summary>/.test(html));
check('guided tour visits End of the day', /sel: '#eodBtn'/.test(html));

// ── End of the day modal ──
check('#eodModal present with confirm + result panes', html.includes('id="eodModal"') && html.includes('id="eodConfirm"') && html.includes('id="eodResult"'));
check('modal shows session/players/fee before generating', html.includes('id="eodDate"') && html.includes('id="eodCount"') && html.includes('id="eodFee"'));
check('summary pane offers Open payment list', /id="eodResult"[\s\S]*?setAdminTab\('payments'\)/.test(html));
check('Escape closes the modal (closeOpenOverlays)', fn('closeOpenOverlays').includes("isOpen('eodModal')"));
check('confirmEndOfDay posts generatePayments and merges entries', fn('confirmEndOfDay').includes("action: 'generatePayments'") && fn('confirmEndOfDay').includes('mergePaymentEntries(') && fn('confirmEndOfDay').includes('eodSummaryText('));
check('confirmEndOfDay closes the modal on a 401 bounce', fn('confirmEndOfDay').includes('if (res === null) { closeEodModal(); return; }'));

// ── Session fee tier ──
const sessAt = html.indexOf('data-tab="session"', html.indexOf('admin-tab-panel'));
const sessionPanel = html.slice(sessAt, html.indexOf('<!-- /session tab -->'));
check('Session Date card has the 2h/3h control', sessionPanel.includes('class="rl-seg fee-seg"') && sessionPanel.includes('data-tier="2h"') && sessionPanel.includes('data-tier="3h"'));
check('renderSessionDateSection repaints the tier (class toggle)', fn('renderSessionDateSection').includes('renderFeeTierSegs()'));
check('renderFeeTierSegs only toggles classes (poll-safe)', fn('renderFeeTierSegs').includes("classList.toggle('on'") && !fn('renderFeeTierSegs').includes('innerHTML'));
check('setSessionFeeTier holds the poll while saving', fn('setSessionFeeTier').includes("pendingTicks.add('feeTier')") && fn('setSessionFeeTier').includes("pendingTicks.delete('feeTier')"));
check('setSessionFeeTier posts feeTier via the generic merge', fn('setSessionFeeTier').includes('apiPost({ feeTier: tier })'));

// ── Payment list: phone-first rules ──
const row = fn('pmRowHtml');
check('row uses one 3-state control (Unpaid + each method)', row.includes("seg('unpaid', 'Unpaid'") && row.includes('Payments.METHODS.forEach'));
check('row fee chip opens the inline editor', row.includes("pmCall('pmToggleFeeEditor', pid)") && row.includes('class="pm-fee-editor"'));
check('every row has a one-tap 2h/3h control (fee is per person)', row.includes('class="pm-tier"') && row.includes("pmCall('pmSetTier', pid, t)") && row.includes('Payments.TIERS.map'));
check('fee editor saves on Save/Enter, never onblur', row.includes("pmCall('pmSaveFee', pid)") && !row.includes('onblur'));
check('fee input is 16px (no iOS zoom)', /\.pm-fee-input\{[^}]*font-size:16px/.test(html));
const mobileAt = html.indexOf('@media(max-width:640px){');
const mobileBlock = html.slice(mobileAt, html.indexOf('/* Desktop multi-column helpers', mobileAt));
check('phone rows stack name+tier / control / meta', mobileBlock.includes('grid-template-areas:"main tier" "ctrl ctrl" "meta meta"'));
check('44px tap targets on mobile', mobileBlock.includes('.pm-tier-seg .rl-seg-btn,.pm-seg .rl-seg-btn{min-height:44px}') && mobileBlock.includes('.fee-seg .rl-seg-btn{min-height:44px;flex:1}') && mobileBlock.includes('.crt-foot .btn{width:100%;min-height:44px}'));
check('no hover-only affordance: fee chip has a 44px hit area', /\.pm-fee::after\{[^}]*inset:-8px/.test(html));
check('unpaid fee chip is red', /\.pm-row:not\(\.paid\) \.pm-fee\{[^}]*color:var\(--red\)/.test(html));
check('calendar strip replaces the prev/next nav', html.includes('id="pmCalGrid"') && html.includes('id="pmCalMonth"') && !html.includes('id="pmPrevBtn"'));
check('calendar marks nights with records and lets you pick any night', fn('renderPmCalendar').includes("'s-has'") && fn('renderPmCalendar').includes('pmSelectDate(') && fn('renderPmCalendar').includes('state.sessions'));
check('past night without records can be generated from the list', fn('renderPmList').includes('pmGenerateFor()') && fn('pmGenerateFor').includes("action: 'generatePayments'"));
check('autosave indicator: saving → saved / error', fn('pmWrite').includes("pmShowSave('saving')") && fn('pmWrite').includes("pmShowSave('saved')") && fn('pmWrite').includes("pmShowSave('error')") && html.includes('id="pmSaveState"'));
check('Paid / Unpaid / Collected tiles open a popup (never change the list filter); Collected shows collected of expected', html.includes('id="pmStats"') && fn('renderPmStats').includes("'Collected'") && fn('renderPmStats').includes('s.expected') && fn('renderPmStats').includes('openPmModal(') && fn('renderPmStats').includes(", 'paid'") && fn('renderPmStats').includes(", 'unpaid'") && fn('renderPmStats').includes(", 'collected'") && !fn('renderPmStats').includes('setPmFilter('));
check('filter is a dropdown styled like the roster sort (All / Unpaid / Paid / each method)', /<select id="pmFilterSel" class="admin-form-input roster-sort pm-filter-sel"/.test(html) && fn('renderPmFilters').includes('Payments.FILTERS') && fn('renderPmFilters').includes('<option'));
check('popup reuses the Membership Tier modal shell with a close button', /<div id="pmModal" role="dialog"[^>]*>\s*<div class="members-box pm-modal-box">\s*<button class="members-close" onclick="closePmModal\(\)"/.test(html) && html.includes('id="pmModalEyebrow"') && html.includes('class="members-headline" id="pmModalTitle"'));
check('popup content: paid → bars + names by method; unpaid → red owing list; collected → hero of expected', fn('renderPmModal').includes('breakdownByMethod(') && fn('renderPmModal').includes('pm-mgroup-names') && fn('renderPmModal').includes('pm-owe-row') && fn('renderPmModal').includes("' expected · '") && !fn('renderPmModal').includes('pmFilter'));
check('Escape / overlay click close the popup', fn('closeOpenOverlays').includes("isOpen('pmModal')") && /id="pmModal"[^>]*onclick="if\(event.target===this\)closePmModal\(\)"/.test(html));
check('dropdown is 44px / 16px on phones', mobileBlock.includes('.pm-filter-sel{width:100%;max-width:none;min-height:44px;font-size:16px}'));
check('owing names are red (popup rows + list under the Unpaid filter)', /\.pm-owe-row \.nm\{color:var\(--red\)\}/.test(html) && /\.pm-name\.owing\{color:var\(--red\)\}/.test(html));
check('bars are one hue with rounded data ends and direct labels', /\.pm-bar-fill\{[^}]*background:var\(--green\)[^}]*border-radius:0 4px 4px 0/.test(html) && fn('pmBarsHtml').includes('pm-bar-val'));
check('empty state points to End of the day', fn('renderPmList').includes('pmGoToCourts()'));
const section = html.slice(html.indexOf('// ── ADMIN: PAYMENTS'), html.indexOf('// ── ADMIN: MONTHLY eligibility'));
check('payments section has no native confirm/alert/prompt', section.length > 1000 && !/\b(confirm|alert|prompt)\(/.test(section));
check('optimistic write restores the snapshot on failure; in-flight key is date|player so one night never blocks another', fn('pmWrite').includes('JSON.parse(snapshot)') && fn('pmWrite').includes('pmBusy.has(key)') && fn('pmWrite').includes("const key = date + '|' + pid"));
check('tap → nextPaymentPatch → setPayment', fn('pmTap').includes('Payments.nextPaymentPatch(') && fn('pmWrite').includes("action: 'setPayment'"));

// ── By member view: running balance per player + member popup ──
check('view toggle: By night / By member segmented control', /<div class="rl-seg pm-view-seg"[^>]*id="pmViewSeg"/.test(html) && html.includes(`data-view="night" aria-selected="true" onclick="pmSetView('night')"`) && html.includes(`data-view="member" aria-selected="false" onclick="pmSetView('member')"`));
check('nightly controls wrapped in #pmNightView; member view has stats, search, filter, list', html.includes('<div id="pmNightView">') && html.includes('<div id="pmMemberView" style="display:none">') && html.includes('id="pmMemStats"') && html.includes('id="pmMemSearch"') && html.includes('id="pmMemFilterSel"') && html.includes('id="pmMemList"'));
check('member view sits inside the Payments tab panel', (() => { const a = html.indexOf('class="admin-tab-panel" data-tab="payments"'); const b = html.indexOf('<!-- /payments tab -->'); const i = html.indexOf('id="pmMemberView"'); return a > -1 && i > a && i < b; })());
check('view choice is remembered per device', fn('pmSetView').includes("localStorage.setItem('pmView', v)") && /localStorage\.getItem\('pmView'\) === 'member'/.test(html));
check('renderPaymentsTab paints the toggle and only builds the calendar for the nightly view', fn('renderPaymentsTab').includes('renderPmViewSeg()') && fn('renderPaymentsTab').includes("if (pmView === 'night')") && fn('renderPaymentsTab').includes('renderPmCalendar()'));
check('renderPmViewSeg shows one view, hides the other, hides the default-fee note off the nightly view', fn('renderPmViewSeg').includes("pmView === 'night' ? '' : 'none'") && fn('renderPmViewSeg').includes("pmView === 'member' ? '' : 'none'") && fn('renderPmViewSeg').includes("getElementById('pmTierNote')"));
check('renderPmBody branches on the view and still repaints an open popup', fn('renderPmBody').includes("if (pmView === 'member') renderPmMembers()") && fn('renderPmBody').includes('renderPmList()') && fn('renderPmBody').includes('if (pmModalKind) renderPmModal()'));
check('member list comes from Payments.memberLedger (roster + attendance), filtered by Payments.filterMembers', fn('pmLedger').includes('Payments.memberLedger(adminOps.attendance, state.roster || [])') && fn('renderPmMembers').includes('Payments.filterMembers(all, { filter: pmMemFilter, query: pmMemQuery })'));
check('member tiles are plain (no popup, never touch the list)', !fn('renderPmMembers').includes('openPmModal(') && !fn('renderPmMembers').includes('setPmMemFilter(') && fn('renderPmMembers').includes("'Outstanding'"));
check('member filter is the same dropdown style with counts (All members / Owing / Settled)', fn('renderPmMembers').includes('Payments.MEMBER_FILTERS.map') && fn('renderPmMembers').includes('Payments.memberFilterLabel(f)') && /<select id="pmMemFilterSel" class="admin-form-input roster-sort pm-filter-sel"/.test(html));
check('search box text is never clobbered while focused', fn('renderPmMembers').includes('document.activeElement !== search'));
check('member row: name, points + tier, red balance, opens the popup', fn('pmMemRowHtml').includes("pmCall('openPmMember', m.playerId)") && fn('pmMemRowHtml').includes('tierForPoints(pts)') && fn('pmMemRowHtml').includes('Payments.memberOweLabel(m)') && fn('pmMemRowHtml').includes(`class="pm-mem-amt' + (owing ? ' owe' : '')`) && /\.pm-mem-amt\.owe\{color:var\(--red\)\}/.test(html));
check('member rows are 44px+ buttons', /\.pm-mem-row\{[^}]*min-height:56px/.test(html) && fn('pmMemRowHtml').includes('<button type="button" class="pm-mem-row'));
check('popup: member kind renders name → points → outstanding → breakdown → paid history', fn('renderPmModal').includes("if (pmModalKind === 'member') { renderPmMemberModal(body, put); return; }") && fn('renderPmMemberModal').includes("put('pmModalTitle', m.name)") && fn('renderPmMemberModal').includes('<span>Points') && fn('renderPmMemberModal').includes("'Outstanding") && fn('renderPmMemberModal').includes('<span>Breakdown</span>') && fn('renderPmMemberModal').includes('<details class="pm-mem-hist"') && fn('renderPmMemberModal').includes('Paid history'));
check('popup order: points + outstanding hero, then breakdown, then history', (() => { const f = fn('renderPmMemberModal'); return f.indexOf('<span>Points') < f.indexOf("'Outstanding") && f.indexOf("'Outstanding") < f.indexOf('<span>Breakdown</span>') && f.indexOf('<span>Breakdown</span>') < f.indexOf('Paid history'); })());
check('breakdown lists owing nights newest first with weekday + date + amount (red until paid)', fn('renderPmMemberModal').includes('m.owing.map(') && fn('pmMemSessHtml').includes('pmDateLabel(x.date,') && fn('pmMemSessHtml').includes('Payments.fmtRM(x.fee)') && fn('pmMemSessHtml').includes(`class="pm-mem-sess-amt' + (x.paid ? '' : ' owe')`) && /\.pm-mem-sess-amt\.owe\{color:var\(--red\)\}/.test(html));
check('paid history is collapsed by default and its open state survives the 2s repaint', fn('openPmMember').includes('pmMemHistOpen = false') && fn('renderPmMemberModal').includes("(pmMemHistOpen ? ' open' : '')") && fn('renderPmMemberModal').includes('ontoggle="pmMemHistOpen=this.open"'));
check('every night in the popup has the one-tap Unpaid/Cash/TnG/DuitNow control', fn('pmMemSessHtml').includes("seg('unpaid', 'Unpaid'") && fn('pmMemSessHtml').includes('Payments.METHODS.forEach') && fn('pmMemSessHtml').includes("pmCall('pmMemTap', pid, x.date, tap)"));
check('popup tap writes to THAT night through the shared writer', fn('pmMemTap').includes('Payments.nextPaymentPatch(e, tap)') && fn('pmMemTap').includes('Payments.isNoopPatch(e, patch)') && /pmWrite\(pid, patch, [^;]*, date\);/.test(fn('pmMemTap')) && fn('pmWrite').includes('const date = atDate || pmDate'));
check('busy state keyed per night in both lists', fn('pmRowHtml').includes("pmBusy.has(pmDate + '|' + pid)") && fn('pmMemSessHtml').includes("pmBusy.has(x.date + '|' + pid)"));
check('autosave indicator reaches the member view and the popup', fn('pmShowSave').includes("querySelectorAll('.pm-save-state')") && html.includes('id="pmMemSaveState"') && /<span class="pm-save-state pm-modal-save" id="pmModalSave"/.test(html));
check('popup eyebrow: nights on record (tier shows once, next to the points)', fn('renderPmMemberModal').includes("put('pmModalEyebrow', 'Member · ' + (m.sessions ? pmNights(m.sessions) + ' on record' : 'no records yet'))") && fn('renderPmMemberModal').includes("<span>Points' + (tier ? ' · ' + escHtml(tier.name) : '')"));
check('collapsed history uses the help-drawer + / – affordance (no static rotate)', /\.pm-mem-hist summary::after\{content:"\+"/.test(html) && /\.pm-mem-hist\[open\] summary::after\{content:"\\2013"\}/.test(html));
check('phones: full-width toggle + 44px search, breakdown rows stack over a full-width control', mobileBlock.includes('.pm-view-seg .rl-seg-btn{flex:1;min-height:44px}') && mobileBlock.includes('.pm-mem-search{max-width:none;min-height:44px;font-size:16px}') && mobileBlock.includes('grid-template-areas:"main amt" "ctrl ctrl"') && mobileBlock.includes('.pm-mem-sess .pm-seg{display:flex;width:100%}'));
check('help drawer explains By member + the keep-while-owing rule', /<summary>Payments<\/summary>[^]*?By member<\/b>[^]*?never removed from history while someone on it still owes/.test(html));

// ── extracted pure glue ──
const paymentEntriesFor = new Function(fn('paymentEntriesFor') + '; return paymentEntriesFor;')();
check('paymentEntriesFor filters to entries with a payment', paymentEntriesFor({ attendance: { d: { entries: { a: { payment: {} }, b: {} } } } }, 'd').length === 1 && paymentEntriesFor(null, 'd').length === 0);
const pmCall = new Function(fn('escHtml') + ';' + fn('pmCall') + '; return pmCall;')();
check('pmCall builds a safe onclick', pmCall('pmTap', 'p1', 'cash') === "pmTap('p1','cash')" && pmCall('f', "a'b") === "f('a\\'b')" && pmCall('f', 'x"y') === "f('x&quot;y')");

console.log(`\npayments ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
