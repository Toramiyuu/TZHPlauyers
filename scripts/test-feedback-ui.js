#!/usr/bin/env node
/* test-feedback-ui — the DOM glue for session feedback in public/index.html: the
 * member-page card (form / summary / hidden), the admin Feedback tab and its nav
 * wiring, the unread badge, and the Settings card. Business rules live in
 * public/feedback.js + lib/feedback.js (test-feedback.js / test-feedback-handler.js). */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const FB = require('../public/feedback.js');
const AdminNav = require('../public/admin-nav.js');

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
const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── the pure module is loaded in the browser ──
check('feedback.js is served to the page', html.includes('<script src="/feedback.js"></script>'));

// ── member card: render it for each state ──
// `fbNight` is the night on screen; '' means "whatever the payload leads with".
function makeCard(fbEditing, fbNight) {
  return new Function('escHtml', 'window', 'Feedback',
    'let fbEditing = ' + (fbEditing ? 'true' : 'false') + ';'
    + 'let fbNight = ' + JSON.stringify(fbNight || '') + ';'
    + fn('fbNightLabel') + ';' + fn('fbChipsHtml') + ';' + fn('fbLabelOf') + ';'
    + fn('fbNightsOf') + ';' + fn('fbSelectedNight') + ';' + fn('fbNightPickerHtml') + ';' + fn('mbFeedbackHtml')
    + '; return mbFeedbackHtml;')(escHtml, { Feedback: FB }, FB);
}
// One night, unanswered — the shape a member sees the first time they look.
const night = (over) => Object.assign({ date: '2026-09-18', latest: true, mine: null, awardable: true }, over || {});
const payload = (over, nights) => Object.assign({
  open: true, night: (nights && nights[0] ? nights[0].date : '2026-09-18'), points: 5,
  goodOptions: FB.GOOD_OPTIONS, badOptions: FB.BAD_OPTIONS,
  mine: (nights && nights[0] ? nights[0].mine : null), nights: nights || [night()],
}, over || {});
const card = makeCard(false);
const OPEN = payload();

check('no card at all when feedback is closed or they have not played yet',
  card({ feedback: { open: false, night: '2026-09-18', nights: [] } }) === '' && card({}) === '' && card(null) === '');
check('no card when the payload claims to be open but lists no nights',
  card({ feedback: payload({ open: true }, []) }) === '');

const form = card({ feedback: OPEN });
check('the night IS the title, named and dated ("Friday 18/9/26")', form.includes('<b>Friday 18/9/26</b>'));
check('the latest night says so, so they know which one they are answering',
  form.includes('Your latest session.'));
check('fbNightLabel spells out every weekday and a 2-digit year', (() => {
  const f = new Function(fn('fbNightLabel') + '; return fbNightLabel;')();
  return f('2026-09-13') === 'Sunday 13/9/26' && f('2026-09-14') === 'Monday 14/9/26'
    && f('2026-12-04') === 'Friday 4/12/26' && f('') === '' && f('junk') === 'junk';
})());
check('both sections are labelled in the organiser\'s own framing',
  form.includes('What went well') && form.includes('What could be better'));
check('all eight options are rendered as pressable chips',
  FB.GOOD_OPTIONS.concat(FB.BAD_OPTIONS).every(o => form.includes('data-id="' + o.id + '"') && form.includes(escHtml(o.label)))
  && (form.match(/aria-pressed="false"/g) || []).length === 8);
check('chips carry their side, so the two groups are read separately',
  (form.match(/data-kind="good"/g) || []).length === 4 && (form.match(/data-kind="bad"/g) || []).length === 4);
check('the two sections are wrapped so they can share a row on a wide screen',
  form.includes('<div class="fb-secs">') && (form.match(/class="fb-sec"/g) || []).length === 2);
check('the member modal can scroll and widens past the shared 400px .modal-box',
  /#accountModal\{[^}]*overflow-y:auto/.test(html) && /#accountModal \.modal-box\{width:min\(/.test(html));
check('two columns only above the breakpoint; one column on a phone',
  /@media\(min-width:620px\)\{[\s\S]{0,400}?\.fb-secs\{grid-template-columns:1fr 1fr/.test(html)
  && /\.fb-secs\{display:grid;grid-template-columns:1fr;/.test(html));
check('each section has its own free-text box, capped at the model\'s limit',
  form.includes('id="fbGoodNote"') && form.includes('id="fbBadNote"')
  && (form.match(/maxlength="500"/g) || []).length === 2 && FB.MAX_NOTE === 500);
check('the points on offer are shown on the button and the header',
  form.includes('+5 points') && form.includes('Send feedback · +5 points') && form.includes('id="fbSendBtn"'));
check('an error line is present for a refused submission', form.includes('id="fbErr"') && form.includes('aria-live="polite"'));
check('it says who sees it', /only goes to the organiser/i.test(form));
check('no Cancel button on a first submission (nothing to go back to)', !form.includes('fbCancelEdit'));

const MINE = { good: ['level'], bad: ['long-wait'], goodNote: '', badNote: 'sat out three rounds', at: 1, updatedAt: 1, awarded: true, awardedPoints: 5 };
const answered = (over) => payload(null, [night(Object.assign({ mine: MINE, awardable: false }, over || {}))]);
const done = card({ feedback: answered() });
check('an existing reply shows the summary, not the form', done.includes('Thanks')
  && !done.includes('id="fbSendBtn"') && !done.includes('id="fbGoodNote"'));
check('the answered night keeps the date as its title', done.includes('<b>Friday 18/9/26</b>'));
check('the summary reads back the chosen options with their labels',
  done.includes('Games were at a good level') && done.includes('Waited too long between games'));
check('good and bad read-backs are distinguishable', done.includes('<li class="good">') && done.includes('<li class="bad">'));
const ALLOWED_GLYPHS = new Set(['✓', '✕', '→', '←', '…']);   // verify-redesign's allow-list
const strayPicto = (s) => (s.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).filter(g => !ALLOWED_GLYPHS.has(g));
check('the read-back uses the two allowed tick/cross glyphs and no emoji (design guard)',
  done.includes('<span>✓</span>') && done.includes('<span>✕</span>') && strayPicto(done).length === 0);
check('their note is quoted back', done.includes('sat out three rounds'));
check('the awarded points are confirmed', done.includes('+5 points'));
check('the summary offers an edit', done.includes('fbStartEdit()') && done.includes('Edit my feedback'));
check('editing flips back to the form, pre-filled and with Cancel', (() => {
  const editing = makeCard(true)({ feedback: answered() });
  return editing.includes('id="fbSendBtn"') && editing.includes('Update my feedback')
    && editing.includes('data-id="level"') && /data-id="level"[^>]*aria-pressed="true"/.test(editing)
    && editing.includes('sat out three rounds') && editing.includes('fbCancelEdit()')
    && !editing.includes('+5 points');   // already paid — don't promise it twice
})());
check('a record that was never paid does not claim points', (() => {
  const c = card({ feedback: answered({ mine: Object.assign({}, MINE, { awarded: false, awardedPoints: 0 }) }) });
  return c.includes('Thanks') && !c.includes('+5 points');
})());
check('the summary reports what was ACTUALLY paid, not today\'s rate', (() => {
  // Organiser has since dropped the reward to 2; this reply earned 5 and must still say so.
  const c = card({ feedback: payload({ points: 2 }, [night({ mine: MINE, awardable: false })]) });
  return c.includes('+5 points') && !c.includes('+2 points');
})());
check('points:0 shows no points promise anywhere',
  !card({ feedback: payload({ points: 0 }, [night({ awardable: false })]) }).includes('points<'));

// ── escaping ──
check('a note with markup is escaped, never injected', (() => {
  const c = card({ feedback: answered({ mine: Object.assign({}, MINE, { badNote: '<img src=x onerror=alert(1)>' }) }) });
  return c.includes('&lt;img src=x') && !c.includes('<img src=x');
})());
check('a label from the payload is escaped too', (() => {
  const c = card({ feedback: payload({ badOptions: [{ id: 'long-wait', label: '<b>hi</b>' }] },
    [night({ mine: { good: [], bad: ['long-wait'] } })]) });
  return c.includes('&lt;b&gt;hi&lt;/b&gt;') && !c.includes('<b>hi</b>');
})());
// ── the collapsed "another night" row ──
const OLDER = night({ date: '2026-09-13', latest: false, awardable: false });
const THREE = payload(null, [night(), OLDER, night({ date: '2026-09-11', latest: false, awardable: false, mine: MINE })]);

check('one night on the list means no picker at all (nothing to pick between)',
  !card({ feedback: OPEN }).includes('fb-more'));
const picked = card({ feedback: THREE });
check('the picker is a collapsed row, not an always-open list',
  /<details class="fb-more"><summary>[^<]*<\/summary>/.test(picked) && picked.includes('Pick another night'));
check('the collapsed row is closed by default (the latest night is the point of the card)',
  !/<details class="fb-more" open/.test(picked));
check('every night they played is a row, the current one included and marked',
  (picked.match(/class="fb-night"/g) || []).length === 3
  && /aria-current="true"[^>]*onclick="fbPickNight\('2026-09-18'\)"/.test(picked)
  && picked.includes("fbPickNight('2026-09-13')") && picked.includes("fbPickNight('2026-09-11')"));
check('each row says where it stands: showing, sent, on offer, or not yet',
  picked.includes('>Showing<') && picked.includes('fb-night-state done">Sent<')
  && picked.includes('>Not yet<'));
check('a night still worth points advertises them in the row', (() => {
  const c = makeCard(false, '2026-09-13')({ feedback: THREE });
  return c.includes('>+5 points<');
})());
check('the rows are dated the same way as the title', picked.includes('>Sunday 13/9/26<') && picked.includes('>Friday 11/9/26<'));
check('the picker rides along on both faces of the card, so it is never a dead end',
  picked.includes('fb-more') && card({ feedback: payload(null, [night({ mine: MINE, awardable: false }), OLDER]) }).includes('fb-more'));

check('picking an older night retitles the card and drops the points promise', (() => {
  const c = makeCard(false, '2026-09-13')({ feedback: THREE });
  return c.includes('<b>Sunday 13/9/26</b>') && !c.includes('class="fb-pts"')
    && !c.includes('Your latest session.') && c.includes('Send feedback</button>');
})());
check('an older night explains why there are no points, rather than going quiet', (() => {
  const c = makeCard(false, '2026-09-13')({ feedback: THREE });
  return /Points are for your latest session/.test(c);
})());
check('an older night that was already answered reads back, with no points excuse', (() => {
  const c = makeCard(false, '2026-09-11')({ feedback: THREE });
  return c.includes('<b>Friday 11/9/26</b>') && c.includes('sat out three rounds')
    && !/Points are for your latest session/.test(c);
})());
check('a stale pick falls back to the latest night instead of blanking the card', (() => {
  const c = makeCard(false, '2026-08-01')({ feedback: THREE });
  return c.includes('<b>Friday 18/9/26</b>');
})());
check('a night with no date is dropped rather than rendered as an empty row',
  !card({ feedback: payload(null, [night(), { date: '', mine: null }]) }).includes('fb-more'));
check('picking a night repaints in place and never leaves the edit form open',
  fn('fbPickNight').includes('fbNight = iso') && fn('fbPickNight').includes('fbEditing = false')
  && fn('fbPickNight').includes('fbRepaint()'));

check('fbLabelOf prefers the payload catalogue, then the module, then the raw id', (() => {
  const f = new Function('window', 'Feedback', fn('fbLabelOf') + '; return fbLabelOf;')({ Feedback: FB }, FB);
  return f({ goodOptions: [{ id: 'level', label: 'Renamed' }] }, 'good', 'level') === 'Renamed'
    && f({}, 'bad', 'long-wait') === 'Waited too long between games'
    && f({}, 'good', 'unknown-id') === 'unknown-id'      // never renders a blank row
    && f({}, 'good', 'level') === 'Games were at a good level';
})());

// ── card wiring on the member page ──
check('the card is mounted inside memberPageHtml, above the standing info',
  fn('memberPageHtml').includes('<div id="mbFeedback">') && fn('memberPageHtml').includes('mbFeedbackHtml(d)')
  && fn('memberPageHtml').indexOf('mbFeedbackHtml(d)') < fn('memberPageHtml').indexOf('mb-progress-wrap'));
check('chips toggle their own pressed state', fn('fbToggleChip').includes("aria-pressed") && fn('fbToggleChip').includes("'true' ? 'false' : 'true'"));
check('only pressed chips of the asked-for side are collected',
  fn('fbChosen').includes('[data-kind="\' + kind + \'"][aria-pressed="true"]'));
check('opening the page always lands on the latest night\'s summary, never a stale edit form',
  fn('openAccountModal').includes('fbEditing = false')
  && fn('openAccountModal').includes("fbNight = typeof keepNight === 'string' ? keepNight : ''"));
check('submit posts the token-gated action with the night, both sides and both notes',
  fn('submitMemberFeedback').includes("acctPost('submitFeedback', { token: acctSession.token, night, good, bad, goodNote, badNote })"));
check('the night on the wire is the one the card is showing',
  fn('submitMemberFeedback').includes('fbSelectedNight(memberInfoCache && memberInfoCache.feedback)'));
check('an empty submission is caught on the client before the round trip',
  fn('submitMemberFeedback').includes("!good.length && !bad.length && !goodNote.trim() && !badNote.trim()"));
check('a 401 signs them out rather than looping', fn('submitMemberFeedback').includes('res.status === 401') && fn('submitMemberFeedback').includes('saveAcctSession(null)'));
check('the reply is checked before the success toast (acctPost does not throw on 4xx)',
  fn('submitMemberFeedback').includes('!res.ok || !res.data || !res.data.ok')
  && fn('submitMemberFeedback').indexOf('!res.ok || !res.data || !res.data.ok')
     < fn('submitMemberFeedback').indexOf("notify(awarded > 0"));
check('a server error is shown in the card, not swallowed', fn('submitMemberFeedback').includes('err.textContent = (res.data && res.data.error)'));
check('the button is disabled while sending, so a double tap cannot double-post',
  fn('submitMemberFeedback').includes('btn.disabled = true'));
check('a successful send re-opens the page on the SAME night, so answering an old one does not bounce back',
  fn('submitMemberFeedback').includes('openAccountModal(night)'));
check('the toast names the points actually awarded', fn('submitMemberFeedback').includes("'Thanks! +' + awarded + ' points added.'"));

// ── admin tab ──
check('feedback is a known tab in the shared nav model', AdminNav.isTab('feedback') && AdminNav.label('feedback') === 'Feedback');
check('it carries an accent (needs-attention) badge', AdminNav.hasAccentBadge('feedback'));
check('the sidebar has the nav item, with its badge', html.includes('data-tab="feedback" onclick="setAdminTab(\'feedback\')"')
  && html.includes('id="navBadgeFeedback"'));
check('the sidebar order matches the canonical TABS order', (() => {
  const order = [...html.matchAll(/class="admin-nav-item" data-tab="([a-z]+)"/g)].map(m => m[1]);
  return JSON.stringify(order) === JSON.stringify(AdminNav.TABS);
})());
check('the tab has a title and a phone icon', html.includes("feedback: 'Feedback'") && /feedback: '<svg class="ic"/.test(html));
check('the panel exists with its calendar, tallies and rows',
  html.includes('<div class="admin-tab-panel" data-tab="feedback">')
  && ['fbCalGrid', 'fbCalMonth', 'fbDateLabel', 'fbStats', 'fbTally', 'fbRows'].every(id => html.includes('id="' + id + '"')));
check('setAdminTab paints from cache then refreshes from the server',
  fn('setAdminTab').includes("if (name === 'feedback') { renderFeedbackTab(); loadAdminOps().then("));
check('opening the tab marks the night as seen', fn('setAdminTab').includes('fbMarkSeen()'));
check('the ops cache carries the records', fn('loadAdminOps').includes('feedback: res.feedback || {}')
  && /let adminOps = \{.*feedback: \{\}.*\};/.test(html));
check('the tab reads ONLY the admin ops cache, never state (it is off the public poll)',
  fn('fbFeedbackMap').includes('adminOps') && !fn('fbFeedbackMap').includes('state.feedback'));

// ── admin tab body ──
{
  const render = new Function('escHtml', 'window', 'Feedback', 'document', 'state', 'adminOps', 'fbDate', 'fmtDateTime',
    fn('fbFeedbackMap') + ';' + fn('fbRosterNames') + ';' + fn('fbTallyHtml') + ';' + fn('fbRowHtml') + ';' + fn('renderFbBody')
    + '; return renderFbBody;');
  const els = {};
  const doc = { getElementById: (id) => (els[id] = els[id] || { innerHTML: '' }) };
  const state = { roster: [{ id: 'p1', name: 'Kelvin' }, { id: 'p2', name: 'Amy' }] };
  const ops = { feedback: { '2026-09-18': {
    p1: { good: ['level'], bad: ['long-wait'], goodNote: '', badNote: '<script>x</script>bad wait', at: 5, updatedAt: 5 },
    p2: { good: ['level', 'variety'], bad: [], goodNote: 'great night', badNote: '', at: 6, updatedAt: 6 },
  } } };
  render(escHtml, { Feedback: FB }, FB, doc, state, ops, '2026-09-18', () => '18 Sep 2026, 22:10')();
  check('admin: the three headline counts are rendered', els.fbStats.innerHTML.includes('<b>2</b><span>Replies</span>')
    && els.fbStats.innerHTML.includes('<b>3</b><span>Good marks</span>') && els.fbStats.innerHTML.includes('<b>1</b><span>Gripe</span>'));
  check('admin: the counts read correctly at one (no "1 Replie")', (() => {
    const solo = {};
    const d = { getElementById: (id) => (solo[id] = solo[id] || { innerHTML: '' }) };
    render(escHtml, { Feedback: FB }, FB, d, state, { feedback: { '2026-09-18': { p1: { good: ['level'], bad: ['long-wait'] } } } }, '2026-09-18', () => '')();
    return solo.fbStats.innerHTML.includes('<b>1</b><span>Reply</span>')
      && solo.fbStats.innerHTML.includes('<b>1</b><span>Good mark</span>')
      && solo.fbStats.innerHTML.includes('<b>1</b><span>Gripe</span>')
      && !/Replie</.test(solo.fbStats.innerHTML);
  })());
  check('admin: both tally blocks appear, widest bar first', els.fbTally.innerHTML.includes('What went well')
    && els.fbTally.innerHTML.includes('What could be better')
    && els.fbTally.innerHTML.indexOf('Games were at a good level') < els.fbTally.innerHTML.indexOf('Good mix of opponents'));
  check('admin: the top option gets a full-width bar', els.fbTally.innerHTML.includes('width:100%'));
  check('admin: unused options are left out of the tally entirely', !els.fbTally.innerHTML.includes('Kept partnering the same people'));
  check('admin: every reply is named (this is the admin-only view)',
    els.fbRows.innerHTML.includes('>Kelvin<') && els.fbRows.innerHTML.includes('>Amy<'));
  check('admin: notes and option tags are shown per player',
    els.fbRows.innerHTML.includes('great night') && els.fbRows.innerHTML.includes('fb-tag good') && els.fbRows.innerHTML.includes('fb-tag bad'));
  check('admin: a note containing markup is escaped', els.fbRows.innerHTML.includes('&lt;script&gt;')
    && !els.fbRows.innerHTML.includes('<script>x</script>'));
  check('admin: roster names win over the names stored on the records',
    els.fbRows.innerHTML.includes('Kelvin') && !els.fbRows.innerHTML.includes('undefined'));

  const empty = {};
  const doc2 = { getElementById: (id) => (empty[id] = empty[id] || { innerHTML: '' }) };
  render(escHtml, { Feedback: FB }, FB, doc2, state, { feedback: {} }, '2026-09-21', () => '')();
  check('admin: an empty night explains itself instead of showing a blank panel',
    empty.fbRows.innerHTML.includes('No feedback for this night yet') && empty.fbTally.innerHTML === '');
}

// ── unread badge ──
check('the badge counts the live night\'s unseen replies', fn('fbUnseenCount').includes('Feedback.countFor')
  && fn('fbUnseenCount').includes('state.sessionDate || todayISO()') && fn('fbUnseenCount').includes('Math.max(0, have - seen)'));
check('the seen mark is per-device (localStorage), not shared state',
  fn('fbSeenMap').includes('localStorage.getItem') && fn('fbMarkSeen').includes('localStorage.setItem'));
check('a corrupt seen-map degrades to zero rather than throwing', fn('fbSeenMap').includes('catch'));
check('the nav badge is wired on every surface (sidebar, phone bar, More sheet)',
  ['navBadgeFeedback', 'bmnBadge-feedback', 'moreBadge-feedback'].every(id => fn('updateAdminNavBadges').includes("setNavBadge('" + id + "'")));
check('the More pill includes the feedback count', fn('updateAdminNavBadges').includes('feedback: fbNew'));

// ── settings card ──
check('the Settings panel has the feedback card', html.includes('id="fbSettingsCard"') && html.includes('id="fbPointsInput"') && html.includes('id="fbToggleBtn"'));
check('the points input is bounded in the markup too', /id="fbPointsInput"[^>]*min="0"[^>]*max="50"/.test(html));
check('the card explains the rules the server actually enforces',
  html.includes('Only players who were there that night can reply, paid or not')
  && html.includes('they can pick any earlier night from the row underneath')
  && html.includes('the points are for their latest session only'));
check('the poll cannot stomp the number while it is being typed',
  fn('renderFeedbackSettingsCard').includes('document.activeElement !== inp'));
check('saving validates with the SAME helper the server uses', fn('saveFeedbackSettings').includes('Feedback.isPointsValue(n)'));
check('saving posts the dedicated action, never a raw state merge',
  fn('saveFeedbackSettings').includes("apiPost({ action: 'setFeedbackSettings', points: n })")
  && fn('toggleFeedbackEnabled').includes("apiPost({ action: 'setFeedbackSettings', enabled: next })"));
check('both savers check the reply before the green toast (apiPost does not throw on 4xx)',
  fn('saveFeedbackSettings').includes('!res || !res.ok') && fn('toggleFeedbackEnabled').includes('!res || !res.ok'));
check('the card is painted with the rest of the admin panel and on tab entry',
  fn('renderAdmin').includes('renderFeedbackSettingsCard()') && fn('setAdminTab').includes("if (name === 'settings') renderFeedbackSettingsCard();"));

console.log('\nfeedback ui: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
