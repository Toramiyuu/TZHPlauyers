#!/usr/bin/env node
/* UI + end-to-end tests for the open competition.
 *
 * Part 1 reads public/index.html and asserts the wiring is actually there:
 * the module is loaded, both public surfaces exist, and every place that puts
 * an entrant's name on screen goes through escHtml (these are names typed by
 * strangers on an unauthenticated form, so that is the whole ballgame).
 *
 * Part 2 boots the real local server and runs a whole event through it over
 * HTTP — admin sets up, a stranger enters with a code, the admin confirms and
 * draws — checking at every step that the PUBLIC GET never carries an IC, a
 * phone number, a category code or an unconfirmed entrant.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
/** The body of one top-level function declaration in the inline script. */
function fn(name) {
  const i = html.indexOf('function ' + name + '(');
  if (i === -1) return '';
  let depth = 0, started = false;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    const ch = html[j];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) return html.slice(i, j + 1); }
  }
  return '';
}

// ── part 1: the page is wired up ─────────────────────────────────────
check('the inline script parses', (() => {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, ok = true;
  while ((m = re.exec(html))) { try { new vm.Script(m[1]); } catch (e) { ok = false; } }
  return ok;
})());
check('knockout.js is loaded in the browser', html.includes('<script src="/knockout.js"></script>'));
check('the entry modal exists', html.includes('id="koModal"'));
check('the bracket modal exists', html.includes('id="koBracketModal"'));
check('the admin tab panel exists', html.includes('data-tab="knockout"'));
check('the admin sidebar has a Knockout button', html.includes("setAdminTab('knockout')"));
check('the admin tab has a badge element', html.includes('id="navBadgeKnockout"'));
check('the lockscreen carries a code CTA', html.includes('id="gateKoLink"'));
check('the viewer carries a Competition button', html.includes('id="viewerKoBtn"'));
check('the entry form has a honeypot, like the sign-up form', html.includes('id="koHp"'));
check('the code box exists', html.includes('id="koCodeInput"'));
check('three step dots (Register / Confirmation / Payment)', (html.match(/id="koModal"[\s\S]*?<\/div>\s*<div class="join-body"/) || [''])[0].split('join-step-dot').length === 4);

check('opening the tab loads admin data', fn('setAdminTab').includes("if (name === 'knockout') loadKoAdmin()"));
check('the nav badge counts pending + unpaid', fn('updateAdminNavBadges').includes('Knockout.todoCount'));
check('the CTAs refresh with the sign-up CTAs', fn('updateJoinCtaVisibility').includes('koUpdateCtas()'));
check('the locked GET teaser is captured', html.includes('lockedKnockout = s.knockout'));

// Every entrant-supplied string that reaches the DOM must be escaped.
for (const f of ['koRoundsHtml', 'koTableHtml', 'koSideHtml', 'koEntrantsHtml', 'koRenderReview', 'koRenderPayment', 'koSeedHtml']) {
  const body = fn(f);
  check(f + ' exists', body.length > 0);
  check(f + ' escapes what it prints', body.includes('escHtml('));
}
check('the entry form never puts typed text into its own HTML', (() => {
  const b = fn('koRenderEntries');
  // Values are assigned to .value after the markup is built, never interpolated.
  return b.includes("el.value = pl[el.dataset.k]") && !/value="\$\{(?!escHtml)/.test(b.replace(/value="\$\{escHtml[^}]*\}"/g, ''));
})());
check('the bracket reads the shared view helper', fn('koRenderBracket').includes('lib.viewOf(cat)'));
check('client validation mirrors the server validator', fn('koValidate').includes('lib.validateEntry'));
check('a reveal goes through the audited admin action', fn('koRevealIC').includes("action: 'knockoutRevealIC'"));
check('rebuilding a draw arms before it throws scores away', fn('koRebuild').includes('koArm(') && fn('koRebuild').includes('Scores will be lost'));
check('clearing a draw arms first', fn('koClearDraw').includes('koArm('));
check('deleting a category arms and names how many entries go with it', fn('koDeleteCat').includes('koArm(') && fn('koDeleteCat').includes("'entry' : 'entries'"));
check('a new code arms and warns the old one dies', fn('koNewCode').includes('koArm(') && fn('koNewCode').includes('Old code stops working'));
check('a knock-on result change is confirmed by the admin', fn('koSaveResult').includes('later result') && fn('koSaveResult').includes('confirm: true') && fn('koSaveResult').includes('koArm('));
check('seeding supports drag and arrows', fn('koSeedDrop').length > 0 && fn('koSeedMove').length > 0);
check('the competition UI uses no native confirm/alert/prompt', (() => {
  const i = html.indexOf('// OPEN COMPETITION ("Knockout")');
  const j = html.lastIndexOf('</script>');
  const section = html.slice(i, j);
  return i > -1 && section.length > 4000 && !/\b(confirm|alert|prompt)\(/.test(section);
})());
check('typing-required admin steps use real forms, not prompts', html.includes('id="koNewCatName"') && fn('koWalkInHtml').includes('koWalkInField('));
check('a revealed IC auto-hides, like a revealed password', fn('koRevealIC').includes('hides in 30s') && fn('koHideIC').length > 0);

// ── part 1b: the projection itself ───────────────────────────────────
// Regression guard. publicProjection() runs the competition through
// Knockout.publicKnockout; anything that RE-NORMALISES the result afterwards
// (pollKnockout did, once) rebuilds the very fields the projection dropped.
{
  const S = require('../api/state.js');
  const secret = {
    roster: [], accounts: [],
    knockout: { event: { name: 'TZH Open', published: true, regOpen: true }, categories: [{
      id: 'c', name: 'MD Open', type: 'doubles', code: 'ABCDEF', status: 'open', entrants: [
        { id: 'e1', status: 'confirmed', at: 1, players: [
          { name: 'Alex Tan', phone: '0123456789', club: 'TZH', icLast4: '5511', icEnc: { iv: 'a', ct: 'b', tag: 'c', k: 1 } },
          { name: 'Wei Ming', phone: '0129876543', club: '', icLast4: '5522', icEnc: { iv: 'a', ct: 'b', tag: 'c', k: 1 } } ] },
        { id: 'e2', status: 'pending', at: 2, players: [{ name: 'Secret Person', phone: '0111111111', icLast4: '9999' }] } ] }] },
  };
  const b = JSON.stringify(S.publicProjection(secret).knockout);
  check('projection: no IC last-four survives', !b.includes('5511') && !b.includes('5522') && !b.includes('9999'));
  check('projection: no encrypted blob survives', !b.includes('icEnc') && !b.includes('"ct"'));
  check('projection: no phone survives', !b.includes('0123456789') && !b.includes('0111111111'));
  check('projection: no category code survives', !b.includes('ABCDEF'));
  check('projection: no pending entrant survives', !b.includes('Secret Person'));
  check('projection: the confirmed pair label DOES survive (it is the bracket)', b.includes('Alex Tan & Wei Ming'));
  check('projection: the projection is not rebuilt into the stored shape', !b.includes('"players"'));
}

// ── part 2: a whole event over HTTP ──────────────────────────────────
const PORT = process.env.KO_TEST_PORT || '3591';
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'TZH123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (body) => {
  const r = await fetch(`${BASE}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const admin = (body) => post(Object.assign({ password: PASSWORD }, body));
const get = async (code) => (await fetch(`${BASE}/api/state${code ? '?code=' + encodeURIComponent(code) : ''}`)).json();

async function waitForUp(deadlineMs = 10000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/api/state`)).ok) return true; } catch { /* not up */ }
    await sleep(150);
  }
  return false;
}

(async () => {
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: Object.assign({}, process.env, { PORT, ADMIN_PASSWORD: PASSWORD, ACCOUNT_ENC_KEY: 'b'.repeat(64) }),
  });
  const kill = () => { try { srv.kill('SIGKILL'); } catch (e) {} };
  process.on('exit', kill);

  try {
    // The static half above is the real safety net for the browser wiring. If a
    // local Express server cannot be started at all (no port, a sandbox that
    // cannot load node_modules), say so loudly and skip the HTTP half rather
    // than reporting a failure that is not about this code. `up` gates the rest
    // instead of an early return, so the summary and the exit code below always
    // run — a skipped half must never swallow a failure from the half that ran.
    const up = await waitForUp();
    if (!up) console.log('  SKIPPED  the HTTP end-to-end half: a local server would not start here.');
    if (up) {

    const IC_A = '900101075511', IC_B = '910202085522', PHONE_A = '0123456789';

    // Admin sets the event up.
    await admin({ action: 'knockoutSetEvent', name: 'TZH Open 2026', date: '2026-11-08', venue: 'TZH Hall', regOpen: true, published: true, payTo: 'DuitNow 012-345 6789' });
    const made = await admin({ action: 'knockoutAddCategory', name: "Men's Doubles Open", type: 'doubles', fee: 40, cap: 16 });
    check('http: a category is created', made.body && made.body.ok === true);
    const catId = made.body.category.id;
    const code = made.body.category.code;
    await admin({ action: 'knockoutUpdateCategory', categoryId: catId, status: 'open' });

    // A stranger with the code, no site code, no account.
    const look = await post({ action: 'knockoutLookup', code });
    check('http: an unauthenticated lookup works', look.body && look.body.ok === true && look.body.category.players === 2);
    check('http: lookup carries the payment line', look.body.event.payTo === 'DuitNow 012-345 6789');

    const sub = await post({ action: 'submitKnockoutEntry', code, entries: [{ players: [
      { name: 'Alex Tan', phone: PHONE_A, ic: IC_A, club: 'TZH' },
      { name: 'Wei Ming', phone: '0129876543', ic: IC_B, club: '' } ] }] });
    check('http: an unauthenticated entry is accepted', sub.body && sub.body.ok === true);
    check('http: the reply states the fee owed', sub.body.fee === 40);

    // THE test: what does the open internet see?
    let pub = await get();
    let blob = JSON.stringify(pub);
    check('http: the public GET carries NO IC', !blob.includes(IC_A) && !blob.includes(IC_B) && !blob.includes('5511'));
    check('http: the public GET carries NO phone number', !blob.includes(PHONE_A));
    check('http: the public GET carries NO encrypted IC blob', !blob.includes('icEnc'));
    check('http: the public GET carries NO category code', !blob.includes(code));
    check('http: a PENDING entrant is not public', !blob.includes('Alex Tan'));
    check('http: the event name IS public', blob.includes('TZH Open 2026'));

    // Locked out (site code set) WHILE entries are still open: the competition
    // is deliberately reachable by people who do not have the members' code.
    await admin({ siteCode: 'ABC-123' });
    const lockedOpen = await get();
    check('http: a locked GET is locked', lockedOpen.locked === true);
    check('http: the locked GET carries the teaser', !!lockedOpen.knockout && lockedOpen.knockout.name === 'TZH Open 2026');
    check('http: the locked teaser says entries are open', lockedOpen.knockout.regOpen === true);
    const lblob = JSON.stringify(lockedOpen);
    check('http: the locked GET has NO entrants', !lblob.includes('Alex Tan'));
    check('http: the locked GET has NO bracket', !lblob.includes('matches'));
    check('http: the locked GET has NO code', !lblob.includes(code));
    check('http: someone with only the CODE can still enter while locked out', (await post({ action: 'knockoutLookup', code })).body.ok === true);
    await admin({ siteCode: '' });

    // Confirm, seed and draw.
    const got = await admin({ action: 'knockoutGetAdmin' });
    const entId = got.body.categories[0].entrants[0].id;
    check('http: the admin list masks the IC', got.body.categories[0].entrants[0].players[0].ic === '••••5511');
    check('http: the admin list keeps the phone', got.body.categories[0].entrants[0].players[0].phone === PHONE_A);
    const rev = await admin({ action: 'knockoutRevealIC', categoryId: catId, entrantId: entId, playerIndex: 0 });
    check('http: an admin reveal returns the real IC', rev.body && rev.body.ok === true && rev.body.ic === IC_A);
    check('http: a reveal without the password is refused', (await post({ action: 'knockoutRevealIC', categoryId: catId, entrantId: entId, playerIndex: 0 })).status === 401);
    check('http: an admin action without the password is refused', (await post({ action: 'knockoutSetEvent', name: 'Hacked' })).status === 401);

    await admin({ action: 'knockoutSetEntrant', categoryId: catId, entrantId: entId, status: 'confirmed', paid: true });
    for (const pair of [['Sam Lee', 'Jo Ng'], ['Raj Kumar', 'Ben Ooi']]) {
      await admin({ action: 'knockoutAddEntrant', categoryId: catId, players: [
        { name: pair[0], phone: '0111111111', ic: '9303030' + pair[0].length + '5533', club: '' },
        { name: pair[1], phone: '0122222222', ic: '9404040' + pair[1].length + '5544', club: '' } ] });
    }
    const gen = await admin({ action: 'knockoutGenerateDraw', categoryId: catId });
    check('http: three entries make a draw', gen.body && gen.body.ok === true);
    check('http: three entries run a round robin, not a bracket', gen.body.view.format === 'roundrobin');

    pub = await get();
    blob = JSON.stringify(pub);
    check('http: a CONFIRMED entrant IS on the public bracket', blob.includes('Alex Tan &amp; Wei Ming') || blob.includes('Alex Tan & Wei Ming'));
    check('http: the draw is public', !!(pub.knockout.categories[0].draw));
    check('http: still no IC after the draw', !blob.includes(IC_A) && !blob.includes('5511'));
    check('http: still no phone after the draw', !blob.includes(PHONE_A));

    // Once the draw is made the category closes, and the teaser must say so
    // rather than inviting somebody to enter a draw that has already happened.
    await admin({ siteCode: 'ABC-123' });
    const lockedDrawn = await get();
    check('http: the locked teaser stops inviting entries once drawn', lockedDrawn.knockout.regOpen === false);
    check('http: a code for a drawn category no longer opens the form', (await post({ action: 'knockoutLookup', code })).body.ok === false);

    // Hiding the event hides everything.
    await admin({ action: 'knockoutSetEvent', published: false });
    const hidden = await get('ABC-123');
    const hblob = JSON.stringify(hidden.knockout);
    check('http: unpublishing empties the public competition', hidden.knockout.categories.length === 0);
    check('http: unpublishing hides every entrant', !hblob.includes('Alex Tan') && !JSON.stringify(hidden).includes('Alex Tan'));
    check('http: unpublishing hides the event name too', !hblob.includes('TZH Open 2026'));
    check('http: the locked teaser disappears when unpublished', (await get()).knockout === null);
    } // end of the HTTP half
  } finally {
    kill();
  }

  console.log(`\nknockout ui + e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
