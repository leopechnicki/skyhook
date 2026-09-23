/* SKYHOOK - the ship's paint.
 *
 * One place that answers "what colour is the rocket right now?", so that
 * js/rocket.js can go back to being a renderer and js/ui_ship.js can be a
 * form. Three things live here and nowhere else:
 *
 *   1. THE COLOUR   one hex, chosen by the player out of a fixed menu.
 *   2. THE MENU     that fixed set, and the reason it is fixed rather than a
 *                   free colour input (see SWATCHES).
 *   3. THE CROWN    the golden hull the current #1 on the leaderboard flies.
 *                   It is an OVERRIDE, not a choice: it hides the player's
 *                   own colour while they hold the top spot and gives it
 *                   straight back when they lose it.
 *
 * ONE COLOUR, NOT FOUR
 * --------------------
 * The brief was "let user choose color of your ship", singular. A four-part
 * palette (nose / window / body / fire) was built first and thrown away: it
 * is four controls and twelve ways to make an ugly rocket, for a feature
 * whose whole job is to be obvious. js/rocket.js DERIVES the plating, the
 * shaded flank, the glass and the plume from this single value, so the ship
 * stays internally consistent at every setting - see resolve() there.
 *
 * The default is Signal Cyan, and that is not a taste call: run the
 * derivation on #35e6ff and it reproduces the six constants js/rocket.js
 * hardcoded before this file existed, to within a couple of channel steps.
 * A player who never opens the customiser sees the game they already had.
 * test/ship.mjs asserts that, so a change to the derivation that would have
 * silently restyled the default ship fails the build instead.
 *
 * This module has no opinion about the network. It is handed a champion name
 * by whoever knows one (js/ui_online.js) and does the comparison; with no
 * backend, no session or no connection it is simply never told, `champion`
 * stays false, and the ship is the player's own colour. That is the contract
 * every online-adjacent file in this repo signs: the game is whole without a
 * server.
 *
 * Nothing here draws. Nothing here calls rand(). Deliberately loadable in a
 * bare JS sandbox with no DOM, because test/ship.mjs does exactly that.
 */
(function (global) {
  'use strict';

  var SK = global.SK || (global.SK = {});

  var STORE_KEY = 'skyhook.shipColour';

  /* ------------------------------------------------------------- the menu */

  /* WHY A MENU AND NOT A COLOUR PICKER
   * ----------------------------------
   * The ship is a ~40 px sprite moving at speed across a starfield that is
   * nearly black (#060713) and full of coloured bodies. A free <input
   * type=color> has one dominant failure: somebody picks #000 or #101018,
   * their ship disappears, and the game reads as broken rather than as
   * customised. A fixed menu is the only way to make "you cannot paint
   * yourself invisible" a property of the feature instead of a warning label
   * on it.
   *
   * Every entry below clears LUMA_FLOOR against the background - asserted in
   * test/ship.mjs, so adding a fashionable near-black here fails the build
   * rather than shipping. The set is deliberately small: twelve is enough to
   * feel like a choice and small enough to fit in four rows of swatches on a
   * phone without a scroll.
   */
  var SWATCHES = [
    { hex: '#35e6ff', name: 'Signal Cyan' },   // the game's own accent
    { hex: '#8af4ff', name: 'Ice' },
    { hex: '#ecf6ff', name: 'Hull White' },
    { hex: '#9db4d6', name: 'Gunmetal' },
    { hex: '#7c8cff', name: 'Ion Blue' },
    { hex: '#b98cff', name: 'Nebula' },
    { hex: '#ff7edb', name: 'Magenta' },
    { hex: '#ff6b7d', name: 'Warning Red' },
    { hex: '#ff9d4d', name: 'Ember' },
    { hex: '#ffd166', name: 'Solar' },
    { hex: '#b6ff6a', name: 'Acid' },
    { hex: '#4dffb4', name: 'Mint' }
  ];

  /* Relative luminance floor, 0..1, measured the way the eye reads it rather
     than by averaging channels. 0.22 keeps every swatch clearly separable
     from the #060713 backdrop (luma 0.005) at sprite size. */
  var LUMA_FLOOR = 0.22;

  /* The exact colour js/rocket.js used to hardcode as TRIM. */
  var DEFAULT = '#35e6ff';

  /* The crown. Deliberately NOT in SWATCHES: gold is not a colour you pick,
     it is a colour you earn, and the moment it appears in the menu the thing
     it signals is worth nothing. Kept clear of 'Solar' (#ffd166) for the same
     reason - the nearest selectable colour must not be mistakable for it,
     which test/ship.mjs measures rather than eyeballs. */
  var GOLD = '#ffc21a';

  /* ------------------------------------------------------------- helpers */

  function store() {
    return SK.Store || { get: function (k, d) { return d; }, set: function () {} };
  }

  /* '#rrggbb' -> [r, g, b]. Returns null for anything else rather than a
     half-parsed colour: a NaN channel renders as transparent black, which is
     the one outcome the whole menu exists to prevent. */
  function rgb(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(hex === undefined || hex === null ? '' : hex).trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* WCAG relative luminance. sRGB channels are gamma-encoded, so a plain
     (r+g+b)/3 badly overrates dark saturated colours - exactly the ones that
     vanish against the starfield. */
  function luma(hex) {
    var c = rgb(hex);
    if (!c) return 0;
    var lin = [0, 0, 0], i, v;
    for (i = 0; i < 3; i++) {
      v = c[i] / 255;
      lin[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  function isSwatch(hex) {
    var h = String(hex === undefined || hex === null ? '' : hex).trim().toLowerCase();
    for (var i = 0; i < SWATCHES.length; i++) {
      if (SWATCHES[i].hex === h) return true;
    }
    return false;
  }

  /* Anything arriving from storage or from the network is UNTRUSTED -
     localStorage is user-editable and the profile row is whatever the last
     client wrote. A value that is not on the menu becomes the default rather
     than being painted. Note what this also buys: GOLD is not on the menu, so
     a hand-edited localStorage entry of '#ffc21a' does not survive this
     function. The crown cannot be stored, only worn. */
  function normalise(raw) {
    var h = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
    return isSwatch(h) ? h : DEFAULT;
  }

  /* ---------------------------------------------------------------- state */

  var colour = null;         // the player's own colour, lazily loaded
  var champion = false;      // is this player currently #1?
  var championName = '';     // who is #1, '' when unknown (offline, etc.)
  var myName = '';           // who this player is, '' when signed out
  var forced = false;        // local preview of the crown (tests, ?gold=1)
  var listeners = [];

  function emit() {
    var cur = current();
    for (var i = 0; i < listeners.length; i++) {
      /* A broken listener must not take the paint job - or the game - down
         with it. Same rule as js/game.js's _ui funnel. */
      try { listeners[i](cur); } catch (e) { /* ignore */ }
    }
  }

  function load() {
    if (colour) return colour;
    colour = normalise(store().get(STORE_KEY, ''));
    return colour;
  }

  function save() {
    try { store().set(STORE_KEY, load()); } catch (e) { /* ignore */ }
  }

  /* What the renderer asks for: the crown if it is being worn, otherwise the
     player's own colour. Synchronous, never throws, never waits on anything.
     That is the whole reason the network can be slow or dead without the ship
     failing to draw - see the note on setChampionName. */
  function current() {
    return (champion || forced) ? GOLD : load();
  }

  function recompute() {
    /* Both names must be known AND equal. An empty name matching an empty
       name would hand the crown to every signed-out player on a dead
       connection, which is the offline-degradation bug this comparison is
       most likely to grow. */
    var next = !!(championName && myName &&
                  championName.toLowerCase() === myName.toLowerCase());
    if (next === champion) return;
    champion = next;
    emit();
  }

  SK.Ship = {
    SWATCHES: SWATCHES,
    DEFAULT: DEFAULT,
    GOLD: GOLD,
    LUMA_FLOOR: LUMA_FLOOR,
    STORE_KEY: STORE_KEY,

    rgb: rgb,
    luma: luma,
    isSwatch: isSwatch,
    normalise: normalise,

    /* The colour in use, crown included. This is what js/rocket.js paints. */
    current: current,

    /* The player's OWN colour, crown excluded - what the customiser shows as
       selected and what gets persisted. Without this the champion would open
       the customiser and find a swatch selected that is not in the menu, and
       every tap would look like it did nothing. */
    saved: function () { return load(); },

    /* Returns true if anything actually changed, so callers can skip a write
       and a repaint on a no-op tap. */
    set: function (hex) {
      var h = String(hex === undefined || hex === null ? '' : hex).trim().toLowerCase();
      if (!isSwatch(h) || load() === h) return false;
      colour = h;
      save();
      emit();
      return true;
    },

    reset: function () { return this.set(DEFAULT); },

    isDefault: function () { return load() === DEFAULT; },

    /* --- the crown ---------------------------------------------------- */

    isChampion: function () { return champion || forced; },
    /* True only when the crown is real - i.e. the leaderboard said so, rather
       than forceChampion() having been used to look at it. The customiser
       needs the difference so it can avoid congratulating somebody on a rank
       they do not hold. */
    isCrowned: function () { return champion; },
    championName: function () { return championName; },

    /* WHO IS #1, AND WHAT HAPPENS WHEN NOBODY KNOWS
     *
     * js/ui_online.js calls this with the rank-1 username from the public
     * leaderboard read, and calls it with '' when that read fails, when there
     * is no backend, or when the board comes back empty. There is no timeout
     * and no retry here on purpose: this module never asks, it is only ever
     * told. So every degradation - no config, no network, a 500, a tunnel -
     * arrives as the same state (championName === '') and produces the same
     * behaviour (the player's own colour). The ship has already been drawn
     * dozens of times by the time any answer lands; the answer only ever
     * flips a boolean and fires onChange, which repaints one sprite. */
    setChampionName: function (name) {
      championName = String(name === undefined || name === null ? '' : name);
      recompute();
    },

    /* The signed-in player's name, '' when signed out. Same source of truth
       the leaderboard highlights "your" row with. */
    setPlayerName: function (name) {
      myName = String(name === undefined || name === null ? '' : name);
      recompute();
    },

    /* Wear the crown without being #1. Used by the tests and by the ?gold=1
       escape hatch on staging so the gold ship can be LOOKED at without
       climbing to the top of a live board first. It does not touch the stored
       colour and is never persisted, so the worst it can do is show one
       person a gold ship for one page load. See the residual-gap note in
       js/ui_ship.js: this is cosmetic, local, and visible to nobody else. */
    forceChampion: function (on) {
      var next = !!on;
      if (next === forced) return;
      forced = next;
      emit();
    },

    /* Fired whenever the ship's appearance changes, for any reason: a swatch
       tap, a colour arriving from the server, or the crown changing hands
       mid-session. */
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },

    /* For the harness: reload from storage as if the page had just opened. */
    _reload: function () { colour = null; load(); emit(); }
  };

}(typeof window !== 'undefined' ? window : this));
