#!/usr/bin/env node
/*
 * test-i18n.js — the English / Chinese switch for player-facing screens.
 *
 * Guards: the translator turns the strings members actually see into Chinese
 * (fixed wording, dates, counts, and "·"-joined lines), leaves what it does not
 * know alone, never reaches into the admin panel, and the page loads it and
 * offers the toggle on the court display and the lock screen.
 *
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const src = fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8');

global.window = {};
global.document = { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null,
  documentElement: {}, getElementById: () => null, body: {} };
global.localStorage = { getItem: () => null, setItem() {} };
global.MutationObserver = undefined;
require(path.join(root, 'public/i18n.js'));
const tr = window.I18N._tr;

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };
const eq = (input, want, scope) => {
  const got = tr(input, scope);
  check(`"${input}" -> "${want}" (got "${got}")`, got === want);
};

// fixed wording
eq('Sign in', '登录');
eq('Lucky Draw', '幸运抽奖');
eq('Members Only', '仅限会员');
// dates, times, counts
eq('Monday 2 November 2026', '2026年11月2日 星期一');
eq('November 2026', '2026年11月');
eq('Wed 4 Nov', '11月4日 周三');
eq('9:00 AM', '上午9:00');
eq('9–11pm', '晚上9–11点');
eq('110 pts', '110 分');
eq('1d 14h', '1天14小时');
eq('12 in the draw', '12 人参加');
eq('Court 2', '2 号场');
// composed lines
eq('Next session Monday 2 November 2026 · 9–11pm', '下一场 2026年11月2日 星期一 · 晚上9–11点');
eq('0 in the draw so far · Pay before Thu 5 Nov · 9:00 AM to be in the draw · 2 winners will be picked',
  '目前 0 人参加 · 在 11月5日 周四 · 上午9:00 前付款即可参加 · 将抽出 2 位得奖者');
eq('Sunday 1 November 2026, draw pending', '2026年11月1日 星期日，待开奖');
eq('Every Friday, Sunday & Monday', '每逢星期五、星期日和星期一');
// names stay, the words around them change
eq('Welcome back, Desmond', '欢迎回来，Desmond');
eq('Boon Chuan + 1 more', 'Boon Chuan 和另外 1 人');
// scoped words only apply in their own screen
eq('in', '还有', '#drawPage');
check('a scoped word is not translated elsewhere', tr('in', '#viewer') === null);
// unknown text is left alone (prize names, free text)
check('unknown text is left untranslated', tr('Tube of shuttlecocks') === null);

// the admin panel is never touched
check('#admin is not a translated root', !/['"]#admin['"]/.test(src.match(/const ROOTS = \[[\s\S]*?\];/)[0]));
// wired into the page
check('index.html loads i18n.js', /<script src="\/i18n\.js"><\/script>/.test(html));
check('the court display has the toggle', /<div class="vh-left">[\s\S]*?class="lang-toggle"[\s\S]*?<\/div>\s*<div class="vh-right">/.test(html));
check('the lock screen has the toggle', /<div id="siteGate">[\s\S]{0,200}class="lang-toggle"/.test(html));

console.log('test-i18n — English / Chinese for player-facing screens\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
}
console.log('RESULT: PASS — i18n assertions green.');
