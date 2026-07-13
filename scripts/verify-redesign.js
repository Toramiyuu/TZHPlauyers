#!/usr/bin/env node
/*
 * verify-redesign.js — static design-system guard for the TZH app.
 *
 * Baseline design system: minimalist Apple-style, light theme. Near-white
 * surfaces (#fbfbfd/#ffffff/#f5f5f7), near-black ink (#1d1d1f), a single blue
 * accent (#0071e3) used sparingly, SF Pro (system font) throughout. The viewer
 * shows clean white player cards with circular avatars.
 *
 * These checks remain as regression guards against the earlier aesthetics
 * leaking back in (the old brand-green, GitHub-dark greys, stray emoji,
 * text-shadow, misused backdrop-filter/!important).
 *
 * Scope of each check (deliberately precise to avoid false positives):
 *   (a) api/state.js passes `node --check`
 *   (b) the inline app <script> parses (new Function — parse only, no exec)
 *   (c) NO old brand-green in EITHER form: rgba(26,158,92  and  #1a9e5c   (whole file)
 *   (d) NO GitHub-dark structural grays (explicit deny-list) in CSS or markup
 *       inline styles — the inline <script> color mirrors + :root are exempt
 *       (CSS custom properties can't reach canvas/JS, so a single JS hex mirror
 *        is the sanctioned location for those values)
 *   (e) every used var(--name) resolves to a --name declared somewhere in the
 *       stylesheet (includes the per-tier local --tc); fallbacks are ignored
 *   (f) no pictographic emoji except the typographic glyphs actually used
 *       (✓ ✕ → ← …)
 *   (g) no literal `transform:rotate(` (the removed static badge) and no
 *       text-shadow — confetti `... rotate()` and ctx.rotate() are allowed
 *   (h) backdrop-filter only on the 3 allowed modal-overlay selectors
 *   (i) !important only on the two allowed lines
 *
 * Exit 0 = all green; exit 1 = one or more violations (printed with line refs).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public', 'index.html');
const STATE_PATH = path.join(ROOT, 'api', 'state.js');

const html = fs.readFileSync(HTML_PATH, 'utf8');

// ── region offsets ────────────────────────────────────────────────
const styleOpen = html.indexOf('<style');
const styleTagEnd = html.indexOf('>', styleOpen);
const styleClose = html.indexOf('</style>', styleTagEnd);
const cssStart = styleTagEnd + 1;
const cssEnd = styleClose;

const rootStart = html.indexOf(':root{', cssStart);
const rootEnd = rootStart === -1 ? -1 : html.indexOf('}', rootStart);

const scriptOpen = html.lastIndexOf('<script');
const scriptTagEnd = html.indexOf('>', scriptOpen);
const scriptClose = html.indexOf('</script>', scriptTagEnd);
const scriptStart = scriptTagEnd + 1;
const scriptEnd = scriptClose === -1 ? html.length : scriptClose;
const scriptSrc = html.slice(scriptStart, scriptEnd);

const inScript = (i) => i >= scriptStart && i < scriptEnd;
const inRoot = (i) => rootStart !== -1 && i >= rootStart && i <= rootEnd;

// The Red vs Blue "Friendly" takeover is a deliberate, self-contained dark/kinetic
// theme (see the sentinels in index.html). Checks (g/h/i) — glow, rotate,
// backdrop-filter, reduced-motion !important — are relaxed ONLY inside that block;
// the rest of the app stays fully strict. Missing sentinels = nothing exempted.
const fvExemptStart = html.indexOf('fv-guard-exempt:start');
const fvExemptEnd = html.indexOf('fv-guard-exempt:end');
const inFriendly = (i) =>
  fvExemptStart !== -1 && fvExemptEnd !== -1 && i > fvExemptStart && i < fvExemptEnd;
// Line-based variant for the split('\n') checks (h/i); computed lazily since it
// needs lineAt, which is declared just below.
const inFriendlyLine = (ln) =>
  fvExemptStart !== -1 && fvExemptEnd !== -1 &&
  ln > lineAt(fvExemptStart) && ln < lineAt(fvExemptEnd);
const lineAt = (i) => html.slice(0, i).split('\n').length;
const snippet = (i) => {
  const lineStart = html.lastIndexOf('\n', i) + 1;
  let lineEnd = html.indexOf('\n', i);
  if (lineEnd === -1) lineEnd = html.length;
  return html.slice(lineStart, lineEnd).trim().slice(0, 140);
};

// ── failure collection ────────────────────────────────────────────
const failures = [];
const fail = (check, line, msg) => failures.push({ check, line, msg });

// scan a regex across an index-predicate-filtered set of matches
function scan(regex, predicate, onHit) {
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(html)) !== null) {
    if (!predicate || predicate(m.index)) onHit(m, m.index);
    if (m.index === regex.lastIndex) regex.lastIndex++; // avoid zero-width loop
  }
}

// (a) api/state.js syntax
try {
  execSync(`node --check ${JSON.stringify(STATE_PATH)}`, { stdio: 'pipe' });
} catch (e) {
  fail('a', 0, `node --check api/state.js failed: ${(e.stderr || e.message).toString().trim().slice(0, 200)}`);
}

// (b) inline script parses
try {
  // eslint-disable-next-line no-new-func
  new Function(scriptSrc); // parse only — does not execute
} catch (e) {
  fail('b', lineAt(scriptStart), `inline <script> failed to parse: ${e.message}`);
}

// (c) old brand-green, both forms (whole file)
scan(/rgba\(26,\s*158,\s*92/g, null, (m, i) => fail('c', lineAt(i), `old green rgba(26,158,92): ${snippet(i)}`));
scan(/#1a9e5c/gi, null, (m, i) => fail('c', lineAt(i), `old green #1a9e5c: ${snippet(i)}`));

// (d) GitHub-dark structural grays in CSS/markup (exempt: inline <script> mirror + :root)
const GREY_DENY = /#(?:0d1117|161b22|30363d|21262d|c9d1d9|adb5bd|e6edf3|8b949e|444c56|111619)\b/gi;
scan(GREY_DENY, (i) => !inScript(i) && !inRoot(i), (m, i) =>
  fail('d', lineAt(i), `GitHub-dark hex ${m[0]} (use a token): ${snippet(i)}`));

// (e) every var(--x) resolves to a declared custom property
const declared = new Set();
{
  let m;
  const declRe = /(--[A-Za-z0-9-]+)\s*:/g;
  while ((m = declRe.exec(html)) !== null) declared.add(m[1]);
}
{
  let m;
  const useRe = /var\(\s*(--[A-Za-z0-9-]+)/g;
  while ((m = useRe.exec(html)) !== null) {
    if (!declared.has(m[1])) fail('e', lineAt(m.index), `var(${m[1]}) is not defined anywhere: ${snippet(m.index)}`);
  }
}

// (f) pictographic emoji except allowed typographic glyphs
const ALLOW_GLYPH = new Set(['✓', '✕', '→', '←', '…']); // ✓ ✕ → ← …
const PICTO = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/gu;
scan(PICTO, null, (m, i) => {
  if (!ALLOW_GLYPH.has(m[0])) fail('f', lineAt(i), `emoji ${JSON.stringify(m[0])} (U+${m[0].codePointAt(0).toString(16).toUpperCase()}): ${snippet(i)}`);
});

// (g) static rotate badge + text-shadow (the Friendly takeover block is exempt)
scan(/transform:\s*rotate\(/g, (i) => !inFriendly(i), (m, i) => fail('g', lineAt(i), `static transform:rotate(: ${snippet(i)}`));
scan(/text-shadow/g, (i) => !inScript(i) && !inFriendly(i), (m, i) => fail('g', lineAt(i), `text-shadow present: ${snippet(i)}`));

// (h) backdrop-filter only on allowed modal selectors
const ALLOWED_BF = ['.modal-overlay', '#pwModal', '#historyModal'];
html.split('\n').forEach((text, idx) => {
  if (!/backdrop-filter/.test(text)) return;
  if (inFriendlyLine(idx + 1)) return; // Friendly takeover ticker is exempt
  const selector = text.slice(0, text.indexOf('{')).trim();
  if (!ALLOWED_BF.some((s) => selector === s || selector.startsWith(s))) {
    fail('h', idx + 1, `backdrop-filter on disallowed selector "${selector}": ${text.trim().slice(0, 100)}`);
  }
});

// (i) !important only on the two allowed lines
html.split('\n').forEach((text, idx) => {
  if (!/!important/.test(text)) return;
  const okAdmin = /#admin\b/.test(text) && /padding/.test(text);
  const okMotion = /scroll-behavior/.test(text);
  const okFriendly = inFriendlyLine(idx + 1); // reduced-motion override in the takeover
  if (!okAdmin && !okMotion && !okFriendly) fail('i', idx + 1, `unexpected !important: ${text.trim().slice(0, 100)}`);
});

// ── report ────────────────────────────────────────────────────────
const NAMES = {
  a: 'state.js syntax', b: 'inline-script parse', c: 'old brand-green (both forms)',
  d: 'GitHub-dark grays (CSS/markup)', e: 'var() resolves', f: 'no emoji (allow ✓ ✕ → ← …)',
  g: 'no static rotate / text-shadow', h: 'backdrop-filter on modals only', i: '!important allow-list',
};
const order = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const byCheck = {};
for (const f of failures) (byCheck[f.check] ||= []).push(f);

console.log('verify-redesign — design-system guard\n');
let failed = 0;
for (const c of order) {
  const fs_ = byCheck[c];
  if (!fs_ || fs_.length === 0) {
    console.log(`  PASS  (${c}) ${NAMES[c]}`);
  } else {
    failed++;
    console.log(`  FAIL  (${c}) ${NAMES[c]} — ${fs_.length} issue(s):`);
    for (const f of fs_.slice(0, 40)) console.log(`          L${f.line}: ${f.msg}`);
    if (fs_.length > 40) console.log(`          … and ${fs_.length - 40} more`);
  }
}
console.log('');
if (failures.length) {
  console.log(`RESULT: FAIL — ${failures.length} violation(s) across ${failed} check(s).`);
  process.exit(1);
} else {
  console.log('RESULT: PASS — all design-system checks green.');
  process.exit(0);
}
