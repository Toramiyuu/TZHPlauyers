/*
 * admin-nav.js — pure logic for the admin panel's PHONE bottom bar ("shortcuts").
 * Loaded in the browser via <script src> (window.AdminNav) and required by api/state.js
 * and the Node tests. No DOM, no dependencies.
 *
 * On phones the grouped sidebar collapses to a 4/5-slot bottom bar: up to
 * MAX_SHORTCUTS tabs chosen by the admins + a fixed "More" button that opens a
 * sheet with every remaining tab. The chosen tabs live in state.adminShortcuts
 * (shared by every admin device, edited in Settings → Phone shortcuts) and are
 * always rendered in the canonical TABS order — the setting is "which", not
 * "in what order". Anything unknown/duplicated/over-cap is normalised away, and
 * an empty or missing list falls back to DEFAULT_SHORTCUTS.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.AdminNav = api;                                             // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Canonical order — matches the desktop sidebar (Today group, then Manage group).
  const TABS = ['session', 'courts', 'payments', 'feedback', 'engagement', 'friendly', 'knockout', 'signups', 'accounts', 'settings'];
  const LABELS = {
    session: 'Session', courts: 'Courts', payments: 'Payments', feedback: 'Feedback', engagement: 'Lucky Draw',
    friendly: 'Friendly', knockout: 'Knockout', signups: 'Sign-ups', accounts: 'Accounts', settings: 'Settings',
  };
  // Shorter labels for the 10px uppercase bottom-bar captions.
  const SHORT_LABELS = { engagement: 'Draw', knockout: 'Comp' };
  const DEFAULT_SHORTCUTS = ['session', 'courts', 'payments'];
  const MIN_SHORTCUTS = 1;
  const MAX_SHORTCUTS = 4;
  // Tabs whose live count is "something needs doing" (blue pill): tonight's unpaid
  // players, unhandled sign-ups, and competition entries waiting to be confirmed
  // or marked paid. These are the only counts the phone bar shows.
  const ACCENT_BADGE_TABS = ['payments', 'knockout', 'signups', 'feedback'];

  const isTab = (id) => typeof id === 'string' && TABS.includes(id);
  const label = (id) => LABELS[id] || '';
  const shortLabel = (id) => SHORT_LABELS[id] || LABELS[id] || '';
  const hasAccentBadge = (id) => ACCENT_BADGE_TABS.includes(id);

  // Coerce any stored value to a clean list: known ids only, deduped, canonical
  // order, capped at MAX. Empty/invalid input → the defaults. Never mutates input.
  function normalizeShortcuts(list) {
    if (!Array.isArray(list)) return DEFAULT_SHORTCUTS.slice();
    const wanted = new Set(list.filter(isTab));
    const out = TABS.filter((t) => wanted.has(t)).slice(0, MAX_SHORTCUTS);
    return out.length >= MIN_SHORTCUTS ? out : DEFAULT_SHORTCUTS.slice();
  }

  // Strict check for what the API will accept from a client (no silent repair there).
  function isValidShortcuts(list) {
    if (!Array.isArray(list)) return false;
    if (list.length < MIN_SHORTCUTS || list.length > MAX_SHORTCUTS) return false;
    if (!list.every(isTab)) return false;
    return new Set(list).size === list.length;
  }

  // Every tab NOT in the bar — this is what the "More" sheet lists.
  function moreTabs(shortcuts) {
    const sc = normalizeShortcuts(shortcuts);
    return TABS.filter((t) => !sc.includes(t));
  }

  // Flip one tab in/out of the bar. Returns { list, error }; on error `list` is the
  // unchanged (normalised) input and `error` is a user-facing sentence.
  function toggleShortcut(shortcuts, id) {
    const sc = normalizeShortcuts(shortcuts);
    if (!isTab(id)) return { list: sc, error: 'Unknown tab.' };
    if (sc.includes(id)) {
      if (sc.length <= MIN_SHORTCUTS) return { list: sc, error: 'Keep at least one shortcut in the bar.' };
      return { list: sc.filter((t) => t !== id), error: null };
    }
    if (sc.length >= MAX_SHORTCUTS) return { list: sc, error: 'Up to ' + MAX_SHORTCUTS + ' shortcuts. Turn one off first.' };
    return { list: TABS.filter((t) => t === id || sc.includes(t)), error: null };
  }

  // The "More" button's own pill: the accent counts of the tabs hidden inside it.
  function moreBadgeTotal(counts, shortcuts) {
    const more = moreTabs(shortcuts);
    return ACCENT_BADGE_TABS
      .filter((t) => more.includes(t))
      .reduce((n, t) => n + (Number(counts && counts[t]) || 0), 0);
  }

  const sameShortcuts = (a, b) => normalizeShortcuts(a).join(',') === normalizeShortcuts(b).join(',');

  return {
    TABS, LABELS, DEFAULT_SHORTCUTS, MIN_SHORTCUTS, MAX_SHORTCUTS, ACCENT_BADGE_TABS,
    isTab, label, shortLabel, hasAccentBadge,
    normalizeShortcuts, isValidShortcuts, moreTabs, toggleShortcut, moreBadgeTotal, sameShortcuts,
  };
});
