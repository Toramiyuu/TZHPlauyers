#!/usr/bin/env node
/* test-member-ui — login-code sign-in + the member page ("My TZH") + the admin
 * Accounts tab code controls, as wired in public/index.html (2026-09). Business
 * rules live in lib/accounts.js + lib/member.js (test-member-codes.js); this
 * guards the DOM glue: code-first sign-in that opens the member page, the page
 * markup from a memberInfo payload, and the admin chips/actions. */
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

// ── sign-in modal: code first, phone behind a link ──
check('auth modal has the code pane with #siCode and the phone pane', html.includes('id="authCodePane"') && html.includes('id="siCode"') && html.includes('id="authPhonePane" style="display:none"'));
check('code input never autocapitalises/autocorrects (codes are typed on phones)', /id="siCode"[^>]*autocapitalize="off"/.test(html) && /id="siCode"[^>]*autocorrect="off"/.test(html));
check('both panes link to each other', html.includes("onclick=\"setSigninWay('phone')\"") && html.includes("onclick=\"setSigninWay('code')\""));
check('openAuthModal clears the code field and restores the remembered way', fn('openAuthModal').includes("'siCode'") && fn('openAuthModal').includes('setSigninWay(preferredSigninWay())'));
check('setSigninWay toggles the panes and focuses the right field', fn('setSigninWay').includes("authCodePane") && fn('setSigninWay').includes("authPhonePane") && fn('setSigninWay').includes("'siPhone' : 'siCode'"));
check('submitCodeSignin posts loginCode and opens the member page on success', fn('submitCodeSignin').includes("acctPost('loginCode', { code })") && fn('submitCodeSignin').includes('onAuthSuccess(res.data)') && fn('submitCodeSignin').indexOf('onAuthSuccess') < fn('submitCodeSignin').indexOf('openAccountModal()'));
check('submitCodeSignin steers blocked (locked/suspended) accounts to the status screen', fn('submitCodeSignin').includes('res.data.blocked') && fn('submitCodeSignin').includes('showStatusScreen(res.data.account)'));
check('successful sign-ins remember their way for next time', fn('submitCodeSignin').includes("localStorage.setItem('tzhSigninWay', 'code')") && fn('submitSignin').includes("localStorage.setItem('tzhSigninWay', 'phone')"));
check('session keeps code + hasPassword from the account view', fn('sessionFromAccount').includes('code: acc.code') && fn('sessionFromAccount').includes('hasPassword: !!acc.hasPassword') && fn('onAuthSuccess').includes('sessionFromAccount(') && fn('refreshAccountSession').includes('sessionFromAccount('));
check('account menu shows the code when there is no phone and names the page', fn('renderAccountWidget').includes('acctSession.phone || acctSession.code') && fn('renderAccountWidget').includes('My points &amp; payments'));
check('"no code" help never mentions a self-signup path', fn('openNoCode').includes('organiser') && !fn('openNoCode').includes('Request an account'));

// ── member page ──
check('openAccountModal fetches memberInfo with the session token', fn('openAccountModal').includes("acctPost('memberInfo', { token })") && fn('openAccountModal').includes('memberPageHtml(res.data)'));
check('openAccountModal handles an expired session and a failed load', fn('openAccountModal').includes('res.status === 401') && fn('openAccountModal').includes('Retry'));
check('openAccountModal ignores a late reply after sign-out', fn('openAccountModal').includes('acctSession.token !== token'));

const factory = new Function('escHtml', 'acctAvatarHtml', 'acctPlayer', 'window', 'Payments',
  fn('mbDate') + ';' + fn('mbNights') + ';' + fn('mbRM') + ';' + fn('memberPageHtml') + '; return memberPageHtml;');
const Payments = require('../public/payments.js');
const page = factory(
  (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  () => '<span class="acctpg-av">H</span>', () => ({ id: 'p0', name: 'Harvey Ng' }), { Payments }, Payments);

const owing = page({
  member: { name: 'Harvey Ng', code: 'HarveyNg#123', hasPassword: false },
  points: { points: 12, threshold: 80, toGo: 68, inDraw: false, monthLabel: 'September 2026' },
  payments: { outstanding: 40, unpaidCount: 2, paidTotal: 20, paidCount: 1, owing: [{ date: '2026-09-08', fee: 25, tier: '3h' }, { date: '2026-09-01', fee: 15, tier: '2h', feeOverridden: true }], settled: [{ date: '2026-09-05', fee: 20, method: 'cash' }] },
  wins: [{ kind: 'monthly', title: 'Monthly draw', label: 'August 2026', prize: 'Racket bag', at: 2 }, { kind: 'session', title: 'Session draw', date: '2026-09-07', prize: '', at: 1 }],
});
check('page: name + code chip', owing.includes('Harvey Ng') && owing.includes('<span class="mb-code">HarveyNg#123</span>'));
check('page: three stats — points, owing (red), wins', owing.includes('<b>12</b><span>Points</span>') && owing.includes('class="mb-stat owe"><b>RM40</b><span>You owe</span>') && owing.includes('<b>2</b><span>Draw wins</span>'));
check('page: Monthly draw progress with points to go', owing.includes('September 2026 draw') && owing.includes('68 more points to enter') && owing.includes('width:15%') && owing.includes('12 / 80 points this month'));
check('page: nights to settle listed newest first with amounts', owing.includes('To settle · 2 nights') && owing.indexOf('Tue 8 Sep 2026') > -1 && owing.indexOf('Tue 8 Sep 2026') < owing.indexOf('Tue 1 Sep 2026') && owing.includes('<b class="owe">RM25</b>') && owing.includes('custom amount'));
check('page: wins list shows prize or Winner', owing.includes('Monthly draw · August 2026') && owing.includes('Racket bag') && owing.includes('Session draw · Mon 7 Sep 2026') && owing.includes('>Winner<'));
check('page: dates use fixed English names (locale-proof)', (() => { const f = new Function(fn('mbDate') + '; return mbDate;')(); return f('2026-09-08') === 'Tue 8 Sep 2026' && f('2026-01-01') === 'Thu 1 Jan 2026' && f('bad') === 'bad'; })());
check('page: paid history is collapsed with totals', owing.includes('<details class="mb-hist">') && owing.includes('1 night · RM20') && owing.includes('Paid · Cash'));
check('page: no Change password button without a password', !owing.includes('Change password') && owing.includes('Contact administrator'));

const clean = page({
  member: { name: 'Ah Sheng', code: '', phone: '012-345 6789', hasPassword: true },
  points: { points: 95, threshold: 80, toGo: 0, inDraw: true, monthLabel: 'September 2026' },
  payments: { outstanding: 0, unpaidCount: 0, paidTotal: 0, paidCount: 0, owing: [], settled: [] },
  wins: [],
});
check('page: settled member — Nothing owing, in the draw, no settle list', clean.includes('<span>Nothing owing</span>') && !clean.includes('mb-stat owe') && clean.includes('You’re in the draw') && clean.includes('width:100%') && !clean.includes('To settle'));
check('page: empty wins state', clean.includes('No prizes yet'));
check('page: phone account shows its phone and a Change password button', clean.includes('012-345 6789') && clean.includes('Change password'));
const hostile = page({ member: { name: 'Ann <b>"x"</b>', code: 'Ann#1<img>' }, points: {}, payments: {}, wins: [{ title: '<script>', prize: '<i>' }] });
check('page: every user string is escaped', !hostile.includes('<b>"x"') && !hostile.includes('<img>') && !hostile.includes('<script>') && !hostile.includes('<i>'));
check('page: tolerates an empty payload', typeof page({}) === 'string' && page({}).includes('Points'));

// ── CSS ──
check('member page + code chip styles exist and use tokens only', html.includes('.mb-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))') && html.includes('.mb-stat.owe b,.mb-stat.owe span{color:var(--red)}') && html.includes('.acct-code{appearance:none') && html.includes('.auth-code-input{'));

// ── admin Accounts tab ──
check('Accounts tab has the Assign codes button + code-aware search', html.includes('id="assignCodesBtn" onclick="assignAllCodes()"') && html.includes('placeholder="Search by name, code or phone…"'));
check('assignAllCodes posts adminAssignCodes and reloads', fn('assignAllCodes').includes("apiPost({ action: 'adminAssignCodes' })") && fn('assignAllCodes').includes('await loadAccountsTab()'));
check('assignCodeFor / regenCode / saveCode / clearCode hit the right actions', fn('assignCodeFor').includes("action: 'adminSetCode', playerId") && fn('regenCode').includes("action: 'adminSetCode', id }") && fn('saveCode').includes("action: 'adminSetCode', id, code") && fn('clearCode').includes("action: 'adminClearCode', id"));
check('blank Save regenerates instead of erroring', fn('saveCode').includes("if (!code) return regenCode(id);"));
check('account card shows the tappable code chip and a code row under Manage', fn('accountCardHtml').includes('${acctCodeChipHtml(a)}') && fn('accountCardHtml').includes('id="codeVal_${id}"') && fn('accountCardHtml').includes(">Login code</span>"));
check('code chip copies on tap and is a real button', fn('acctCodeChipHtml').includes('<button type="button" class="acct-code"') && fn('acctCodeChipHtml').includes("pmCall('copyCode', a.code)"));
check('roster players without an account get an Assign code row', fn('renderAcctList').includes('unlinkedRosterHtml(needle)') && fn('unlinkedRosterHtml').includes("pmCall('assignCodeFor', r.id)") && fn('unlinkedRosterHtml').includes('No login code yet'));
check('counters lead with Login codes / No code', fn('renderAcctCounters').includes("['Login codes', codedPlayers.size, 'ok']") && fn('renderAcctCounters').includes("['No code', noCode"));
check('search matches codes regardless of # / spaces', fn('renderAcctList').includes("codeNeedle") && fn('renderAcctList').includes("(a.code || '').toLowerCase().replace("));
check('audit labels cover the code actions', html.includes("'account.codes_assign': 'Login codes assigned'") && html.includes("'account.code_set': 'Login code set'") && html.includes("'account.code_clear': 'Login code removed'"));
check('help drawer explains login codes', /help-sec"><summary>Accounts<\/summary><div>Members sign in with a <b>login code<\/b>/.test(html));
check('client code suggestion matches the server shape', (() => { const f = new Function(fn('codeSuggestion') + '; return codeSuggestion;')(); return f('Harvey Ng') === 'HarveyNg#123' && f('') === 'Member#123'; })());

// ── hygiene: no native dialogs in the new glue ──
const glue = ['submitCodeSignin', 'openNoCode', 'openAccountModal', 'memberPageHtml', 'assignAllCodes', 'assignCodeFor', 'regenCode', 'saveCode', 'clearCode', 'copyCode', 'unlinkedRosterHtml'].map(fn).join('\n');
check('new glue found', glue.length > 3000);
check('no native confirm/alert/prompt in the new glue', !/\b(confirm|alert|prompt)\(/.test(glue));

console.log(`\nmember ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
