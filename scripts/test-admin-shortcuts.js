#!/usr/bin/env node
/* test-admin-shortcuts — configurable PHONE bottom bar (2026-09-11).
 * Admins pick which tabs sit in the mobile bottom bar (Settings → Phone shortcuts);
 * default Session, Courts, Payments; "More" always lists the rest. Pure rules live in
 * public/admin-nav.js (exercised directly); this also guards the api/state.js
 * validation and the index.html DOM glue (renderer, badges, poll sync, settings card). */
'use strict';
const fs = require('fs');
const path = require('path');
const AdminNav = require('../public/admin-nav.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'state.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

// ── pure rules ──
const D = AdminNav.DEFAULT_SHORTCUTS;
check('default is Session, Courts, Payments', eq(D, ['session', 'courts', 'payments']));
check('every default is a known tab', D.every(AdminNav.isTab));
check('8 tabs in sidebar order', eq(AdminNav.TABS, ['session', 'courts', 'payments', 'engagement', 'friendly', 'signups', 'accounts', 'settings']));
check('cap is 4, floor is 1', AdminNav.MAX_SHORTCUTS === 4 && AdminNav.MIN_SHORTCUTS === 1);

check('normalize: missing -> default', eq(AdminNav.normalizeShortcuts(undefined), D) && eq(AdminNav.normalizeShortcuts(null), D));
check('normalize: non-array -> default', eq(AdminNav.normalizeShortcuts('session'), D) && eq(AdminNav.normalizeShortcuts({}), D));
check('normalize: empty -> default', eq(AdminNav.normalizeShortcuts([]), D));
check('normalize: all-unknown -> default', eq(AdminNav.normalizeShortcuts(['nope', 42, null]), D));
check('normalize: drops unknown, keeps known', eq(AdminNav.normalizeShortcuts(['settings', 'bogus']), ['settings']));
check('normalize: dedupes', eq(AdminNav.normalizeShortcuts(['courts', 'courts', 'session']), ['session', 'courts']));
check('normalize: canonical order regardless of input order', eq(AdminNav.normalizeShortcuts(['settings', 'session', 'engagement']), ['session', 'engagement', 'settings']));
check('normalize: caps at 4 (first 4 in canonical order)', eq(AdminNav.normalizeShortcuts(AdminNav.TABS.slice().reverse()), ['session', 'courts', 'payments', 'engagement']));
check('normalize: never mutates input', (() => { const inp = ['courts', 'session']; AdminNav.normalizeShortcuts(inp); return eq(inp, ['courts', 'session']); })());
check('normalize: returns a fresh default array each time', AdminNav.normalizeShortcuts() !== AdminNav.normalizeShortcuts() && AdminNav.normalizeShortcuts() !== D);

check('isValid: default ok', AdminNav.isValidShortcuts(D));
check('isValid: 1 and 4 ok', AdminNav.isValidShortcuts(['friendly']) && AdminNav.isValidShortcuts(['session', 'courts', 'payments', 'signups']));
check('isValid: empty rejected', !AdminNav.isValidShortcuts([]));
check('isValid: 5 rejected', !AdminNav.isValidShortcuts(['session', 'courts', 'payments', 'signups', 'settings']));
check('isValid: unknown id rejected', !AdminNav.isValidShortcuts(['session', 'nope']));
check('isValid: duplicate rejected', !AdminNav.isValidShortcuts(['session', 'session']));
check('isValid: non-array rejected', !AdminNav.isValidShortcuts('session') && !AdminNav.isValidShortcuts(null));

check('moreTabs: complement of the defaults', eq(AdminNav.moreTabs(D), ['engagement', 'friendly', 'signups', 'accounts', 'settings']));
check('moreTabs: complement of a custom list, canonical order', eq(AdminNav.moreTabs(['settings', 'signups']), ['session', 'courts', 'payments', 'engagement', 'friendly', 'accounts']));
check('moreTabs: garbage in -> complement of defaults', eq(AdminNav.moreTabs('x'), AdminNav.moreTabs(D)));
check('bar + More always cover all 8 tabs exactly once', (() => {
  const sc = ['accounts', 'courts'];
  const all = AdminNav.normalizeShortcuts(sc).concat(AdminNav.moreTabs(sc)).sort();
  return eq(all, AdminNav.TABS.slice().sort());
})());

check('toggle: add keeps canonical order', (() => { const r = AdminNav.toggleShortcut(D, 'engagement'); return !r.error && eq(r.list, ['session', 'courts', 'payments', 'engagement']); })());
check('toggle: add inserts before later tabs', (() => { const r = AdminNav.toggleShortcut(['courts', 'settings'], 'session'); return !r.error && eq(r.list, ['session', 'courts', 'settings']); })());
check('toggle: remove', (() => { const r = AdminNav.toggleShortcut(D, 'courts'); return !r.error && eq(r.list, ['session', 'payments']); })());
check('toggle: refuses to empty the bar', (() => { const r = AdminNav.toggleShortcut(['session'], 'session'); return /at least one/i.test(r.error) && eq(r.list, ['session']); })());
check('toggle: refuses a 5th', (() => { const r = AdminNav.toggleShortcut(['session', 'courts', 'payments', 'engagement'], 'settings'); return /up to 4/i.test(r.error) && r.list.length === 4; })());
check('toggle: unknown id is an error', /unknown/i.test(AdminNav.toggleShortcut(D, 'nope').error));
check('toggle: never mutates input', (() => { const inp = D.slice(); AdminNav.toggleShortcut(inp, 'courts'); return eq(inp, D); })());

check('accent badges only on Payments + Sign-ups', eq(AdminNav.ACCENT_BADGE_TABS, ['payments', 'signups']) && AdminNav.hasAccentBadge('payments') && !AdminNav.hasAccentBadge('courts'));
check('More pill: defaults -> only sign-ups count (payments is in the bar)', AdminNav.moreBadgeTotal({ payments: 3, signups: 2 }, D) === 2);
check('More pill: payments hidden in More -> both counts', AdminNav.moreBadgeTotal({ payments: 3, signups: 2 }, ['session']) === 5);
check('More pill: nothing hidden -> 0', AdminNav.moreBadgeTotal({ payments: 3, signups: 2 }, ['payments', 'signups']) === 0);
check('More pill: tolerates missing counts', AdminNav.moreBadgeTotal(null, ['session']) === 0 && AdminNav.moreBadgeTotal({ payments: 'x' }, ['session']) === 0);
check('labels: Lucky Draw shortens to Draw in the bar', AdminNav.label('engagement') === 'Lucky Draw' && AdminNav.shortLabel('engagement') === 'Draw' && AdminNav.shortLabel('payments') === 'Payments');
check('sameShortcuts ignores order + junk', AdminNav.sameShortcuts(['courts', 'session', 'zzz'], ['session', 'courts']) && !AdminNav.sameShortcuts(D, ['session']));

// ── api/state.js ──
check('api requires the shared module', api.includes("require('../public/admin-nav.js')"));
check('DEFAULT_STATE carries the default shortcuts', api.includes('adminShortcuts: AdminNav.DEFAULT_SHORTCUTS.slice()'));
check('GET normalises stored shortcuts', api.includes('current.adminShortcuts = AdminNav.normalizeShortcuts(current.adminShortcuts)'));
check('POST rejects an invalid list with 400', api.includes('if (!AdminNav.isValidShortcuts(updates.adminShortcuts))') && /isValidShortcuts\(updates\.adminShortcuts\)\)\s*\{\s*return res\.status\(400\)/.test(api));
check('POST stores the normalised (canonical-order) list', api.includes('updates.adminShortcuts = AdminNav.normalizeShortcuts(updates.adminShortcuts)'));

// ── index.html wiring ──
check('admin-nav.js is loaded before the app script', html.includes('<script src="admin-nav.js"></script>') && html.indexOf('<script src="admin-nav.js">') < html.lastIndexOf('<script>'));
check('bottom nav + More sheet are empty shells filled by JS', /<nav class="admin-bottomnav" id="adminBottomNav"><\/nav>/.test(html) && html.includes('<div id="moreSheetTabs"></div>'));
check('no hard-coded ADMIN_MORE_TABS list remains', !html.includes('ADMIN_MORE_TABS'));
check('setAdminTab lights More via the dynamic list', fn('setAdminTab').includes('adminMoreTabs().includes(name)'));
check('renderMobileNav paints both surfaces + badges', fn('renderMobileNav').includes("getElementById('adminBottomNav')") && fn('renderMobileNav').includes("getElementById('moreSheetTabs')") && fn('renderMobileNav').includes('updateAdminNavBadges()'));
check('bar is painted at script load (defaults) and on renderAdmin', /^renderMobileNav\(\);$/m.test(html) && fn('renderAdmin').includes('renderMobileNav()') && fn('renderAdmin').includes('renderShortcutsCard()'));
check('poll syncs the bar only when the list changed', fn('poll').includes('syncMobileNav()') && fn('syncMobileNav').includes("adminShortcuts().join(',') === mobileNavKey"));
check('badges address bar pill or More row for payments + sign-ups', ['bmnBadge-payments', 'moreBadge-payments', 'bmnBadge-signups', 'moreBadge-signups'].every(id => fn('updateAdminNavBadges').includes(`setNavBadge('${id}'`)));
check('More pill sums only the hidden accent tabs', fn('updateAdminNavBadges').includes('AdminNav.moreBadgeTotal({ payments: unpaid, signups: su }, adminShortcuts())'));
check('old fixed More badge ids are gone', !html.includes('moreBadgePayments') && !html.includes('moreBadgeSignups'));
check('any bar button can carry the count pill', html.includes('.admin-bmn-btn .signup-badge{position:absolute') && /\.admin-bmn-btn\{position:relative/.test(html));
check('bar labels never overflow a 5-slot bar', /\.bmn-label\{[^}]*text-overflow:ellipsis/.test(html));

// Settings card
check('Settings has the Phone shortcuts card', html.includes('id="shortcutsCard"') && html.includes('Phone shortcuts') && html.includes('id="shortcutsList"') && html.includes('id="shortcutsPreview"'));
check('card sits inside the settings panel', (() => { const s = html.indexOf('data-tab="settings"', html.indexOf('admin-tab-panel')); const e = html.indexOf('<!-- /settings tab -->'); const i = html.indexOf('id="shortcutsCard"'); return s > -1 && i > s && i < e; })());
check('one switch per tab, wired to toggleShortcut', fn('renderShortcutsCard').includes('AdminNav.TABS.map(') && fn('renderShortcutsCard').includes("onchange=\"toggleShortcut('${id}')\"") && fn('renderShortcutsCard').includes('class="sc-switch"'));
check('preview mirrors the bar + trailing More', fn('renderShortcutsCard').includes("getElementById('shortcutsPreview')") && fn('renderShortcutsCard').includes('sc-pv-more'));
check('toggle re-reads server state, surfaces rule errors, never alerts', fn('toggleShortcut').includes('await refreshState()') && fn('toggleShortcut').includes('AdminNav.toggleShortcut(adminShortcuts(), id)') && fn('toggleShortcut').includes("notify(r.error, 'warn')") && !/\b(alert|confirm|prompt)\(/.test(fn('toggleShortcut') + fn('saveShortcuts') + fn('resetShortcuts')));
check('save posts adminShortcuts and repaints bar + card', fn('saveShortcuts').includes('apiPost({ adminShortcuts: list })') && fn('saveShortcuts').includes('renderMobileNav()') && fn('saveShortcuts').includes('renderShortcutsCard()'));
check('reset button restores the defaults', html.includes('onclick="resetShortcuts()"') && fn('resetShortcuts').includes('AdminNav.DEFAULT_SHORTCUTS.slice()'));
check('switch uses the blue accent, no emoji, no !important', html.includes('.sc-switch input:checked ~ .sc-track{background:var(--a-blue)}') && !/\.sc-[a-z-]*\{[^}]*!important/.test(html));
check('help drawer documents the setting', /phone shortcuts<\/b>/.test(html));
// Discoverability: the More sheet itself links to the card.
check('More sheet has an Edit shortcuts row', html.includes('id="amsEditShortcuts"') && html.includes('onclick="closeMoreSheet();openShortcutsSettings()"') && html.includes('<span>Edit shortcuts</span>'));
check('Edit shortcuts row sits in the fixed footer, after the dynamic tab rows', html.indexOf('id="amsEditShortcuts"') > html.indexOf('<div id="moreSheetTabs"></div>') && html.indexOf('id="amsEditShortcuts"') < html.indexOf('showViewer();closeMoreSheet()'));
check('openShortcutsSettings opens Settings, scrolls to the card and flashes it', fn('openShortcutsSettings').includes("setAdminTab('settings')") && fn('openShortcutsSettings').includes("getElementById('shortcutsCard')") && fn('openShortcutsSettings').includes('scrollIntoView') && fn('openShortcutsSettings').includes("classList.add('sc-flash')"));
check('flash + scroll offset styled without !important', html.includes('#shortcutsCard.sc-flash{box-shadow:0 0 0 3px var(--a-blue)}') && /#shortcutsCard\{scroll-margin-top/.test(html) && !/#shortcutsCard[^\n]*!important/.test(html));

// ── executed glue: mobileNavHtml with stubs ──
const factory = new Function('AdminNav', 'escHtml', 'ADMIN_NAV_ICONS',
  fn('mobileNavHtml') + '; return mobileNavHtml;');
const icons = Object.fromEntries(AdminNav.TABS.concat('more').map(t => [t, `<svg data-i="${t}"></svg>`]));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const mobileNavHtml = factory(AdminNav, esc, icons);
{
  const out = mobileNavHtml(undefined, 'session');
  const barTabs = [...out.bar.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
  const sheetTabs = [...out.sheet.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
  check('default bar = Session, Courts, Payments (+ More)', eq(barTabs, ['session', 'courts', 'payments']) && out.bar.includes('id="bmnMore"') && out.bar.endsWith('</button>'));
  check('default sheet = the other five', eq(sheetTabs, ['engagement', 'friendly', 'signups', 'accounts', 'settings']));
  check('active tab highlighted in the bar; More not lit', out.bar.includes('class="admin-bmn-btn active" data-tab="session"') && !out.bar.includes('admin-bmn-more active'));
  check('Payments bar button carries its unpaid pill; Sign-ups row carries its pill', out.bar.includes('id="bmnBadge-payments"') && !out.bar.includes('id="bmnBadge-session"') && out.sheet.includes('id="moreBadge-signups"') && !out.sheet.includes('id="moreBadge-payments"'));
  check('bar uses short labels, sheet uses full labels', out.bar.includes('>Payments<') && out.sheet.includes('>Lucky Draw<') && out.sheet.includes('>Sign-ups<'));
  check('key mirrors the normalised list', out.key === 'session,courts,payments');
}
{
  const out = mobileNavHtml(['settings', 'engagement', 'signups', 'session', 'bogus'], 'accounts');
  const barTabs = [...out.bar.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
  check('custom list renders in canonical order, junk dropped', eq(barTabs, ['session', 'engagement', 'signups', 'settings']));
  check('More is lit when the active tab is in the sheet', out.bar.includes('admin-bmn-more active') && out.sheet.includes('class="ams-item active" data-tab="accounts"'));
  check('Draw label used for Lucky Draw in the bar', out.bar.includes('>Draw<'));
  check('Sign-ups pill moved to the bar; Payments pill now in the sheet', out.bar.includes('id="bmnBadge-signups"') && out.sheet.includes('id="moreBadge-payments"'));
}

console.log(`test-admin-shortcuts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
