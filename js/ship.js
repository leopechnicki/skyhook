/* SKYHOOK - the ship's paint.
 *
 * One place that answers "what colour is each part of the rocket right now?",
 * so that js/rocket.js can go back to being a renderer and js/ui_ship.js can
 * be a form. Four things live here and nowhere else:
 *
 *   1. THE PAINT    one colour per PART - nose, window, body, fire - each
 *                   chosen by the player out of a fixed menu.
 *   2. THE MENU     that fixed set, and why it is fixed (see SWATCHES).
 *   3. THE RULE     that no combination may make the ship unreadable, and the
 *                   code that enforces it (see readable() and normalise()).
 *   4. THE CROWN    the golden hull the current #1 on the leaderboard flies.
 *                   It is an OVERRIDE, not a choice: it covers all four parts
 *                   while the player holds the top spot and gives their own
 *                   paint straight back, untouched, when they lose it.
 *
 * FOUR PARTS, AND WHY A MENU IS NO LONGER ENOUGH ON ITS OWN
 * --------------------------------------------------------
 * Leo asked for per-part colour; the first version shipped one colour with
 * the parts derived from it, and that call should have been put to him rather
 * than made here. It has now been made the other way (2026-09-23): each of
 * nose / window / body / fire is picked separately.
 *
 * The single colour existed so that nobody could paint themselves invisible.
 * With one colour, a menu of colours that each clear a floor against the
 * starfield was a complete answer. With four, it is not: every swatch is
 * individually visible, but the nose cone and the porthole are drawn ON the
 * pale plating, not on the sky, so a pale nose or a pale window on a pale
 * hull vanishes even though each colour is "legal". 32 of the 144
 * (body, window) and (body, nose) pairs on the menu do exactly that.
 *
 * So the rule is now a property of the COMBINATION, measured on the colours
 * the renderer actually paints (SK.Rocket.resolve), and enforced twice:
 *
 *   - set() refuses a pick that would break it, and says why (why()).
 *   - normalise() - the gate every stored, synced or hand-edited paint passes
 *     through before it can reach the renderer - CORRECTS a combination that
 *     breaks it, deterministically: the offending part goes back to its
 *     default. It never paints "looks wrong but allowed".
 *
 * test/ship.mjs walks all 12^4 menu combinations through both.
 *
 * The defaults are Signal Cyan on every part, and that is not a taste call:
 * js/rocket.js's derivation on #35e6ff reproduces the six constants it
 * hardcoded before any of this existed. A player who never opens the
 * customiser sees the game they already had; test/ship.mjs asserts that.
 *
 * This module has no opinion about the network. It is handed a champion name
 * by whoever knows one (js/ui_ship.js) and does the comparison; with no
 * backend, no session or no connection it is simply never told, `champion`
 * stays false, and the ship is the player's own paint. That is the contract
 * every online-adjacent file in this repo signs: the game is whole without a
 * server.
 *
 * Nothing here draws. Nothing here calls rand(). Deliberately loadable in a
 * bare JS sandbox with no DOM, because test/ship.mjs does exactly that.
 */
(function (global) {
  'use strict';

  var SK = global.SK || (global.SK = {});

  var STORE_KEY = 'skyhook.shipPaint';
  /* Where the single-colour build kept its one hex. Read once, migrated into
     all four parts, so a player who painted their ship before this change
     keeps the ship they painted. */
  var LEGACY_KEY = 'skyhook.shipColour';

  /* ------------------------------------------------------------- the menu */

  /* WHY A MENU AND NOT A COLOUR PICKER
   * ----------------------------------
   * The ship is a ~40 px sprite moving at speed across a starfield that is
   * nearly black (#060713) and full of coloured bodies. A free <input
   * type=color> has one dominant failure: somebody picks #000 or #101018,
   * their ship disappears, and the game reads as broken rather than as
   * customised. The menu keeps every individual colour on the right side of
   * that line; readable() keeps the COMBINATIONS there.
   *
   * Every entry below clears LUMA_FLOOR against the background - asserted in
   * test/ship.mjs, so adding a fashionable near-black here fails the build
   * rather than shipping. Same twelve for every part: one menu to learn, and
   * one allow-list for the database to hold (supabase/schema.sql section 8).
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

  /* The four surfaces, in the order the customiser shows them. `on` is what
     the part is painted against, which is what decides how it can fail:
     the body's rim and the plume are seen against the SKY, the nose cone and
     the porthole against the ship's own PLATING. */
  var PARTS = ['nose', 'window', 'body', 'fire'];
  var PART_INFO = {
    nose:   { label: 'Nose',   on: 'plating' },
    window: { label: 'Window', on: 'plating' },
    body:   { label: 'Body',   on: 'sky' },
    fire:   { label: 'Fire',   on: 'sky' }
  };

  /* Relative luminance floor, 0..1, measured the way the eye reads it rather
     than by averaging channels. 0.22 keeps every swatch clearly separable
     from the #060713 backdrop (luma 0.005) at sprite size. */
  var LUMA_FLOOR = 0.22;

  /* The backdrop the whole ship is judged against. */
  var SKY = '#060713';

  /* THE TWO DISTANCES, in OKLab (a perceptual colour space: equal distances
     look equally different, which RGB and plain contrast ratio do not - Acid
     on white plating has a contrast ratio of 1.06 and is perfectly obvious,
     because the difference is hue, not brightness).

     SKY_DE    what the rim and the plume need against the starfield. Every
               swatch clears it by a mile (the dimmest, Ion Blue, sits at
               0.56); it is here for input that did NOT come from the menu.
     MARK_DE   what the nose cone and the porthole need against the plating.
               Calibrated on the real menu rather than guessed: every pair
               the eye loses sits at or under 0.080 (Ice window 0.052, Hull
               White nose 0.016), and the default ship's faintest marking -
               its own porthole - is 0.106. 0.08 is the gap between them. */
  var SKY_DE = 0.40;
  var MARK_DE = 0.08;

  /* The exact colour js/rocket.js used to hardcode as TRIM. */
  var DEFAULT = '#35e6ff';
  var DEFAULTS = { nose: DEFAULT, window: DEFAULT, body: DEFAULT, fire: DEFAULT };

  /* The crown. Deliberately NOT in SWATCHES: gold is not a colour you pick,
     it is a colour you earn, and the moment it appears in the menu the thing
     it signals is worth nothing. Kept clear of 'Solar' (#ffd166) for the same
     reason - the nearest selectable colour must not be mistakable for it,
     which test/ship.mjs measures rather than eyeballs. It covers all four
     parts: a gold hull with somebody's magenta nose is not a crown. */
  var GOLD = '#ffc21a';
  var GOLD_PAINT = { nose: GOLD, window: GOLD, body: GOLD, fire: GOLD };

  /* ------------------------------------------------------------- helpers */

  function store() {
    return SK.Store || { get: function (k, d) { return d; }, set: function () {} };
  }

  function str(v) { return String(v === undefined || v === null ? '' : v).trim().toLowerCase(); }

  /* '#rrggbb' -> [r, g, b]. Returns null for anything else rather than a
     half-parsed colour: a NaN channel renders as transparent black, which is
     the one outcome the whole menu exists to prevent. */
  function rgb(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(str(hex));
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function linear(v) {
    v = v / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  /* WCAG relative luminance. sRGB channels are gamma-encoded, so a plain
     (r+g+b)/3 badly overrates dark saturated colours - exactly the ones that
     vanish against the starfield. */
  function luma(hex) {
    var c = rgb(hex);
    if (!c) return 0;
    return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
  }

  /* [r, g, b] (0..255) -> OKLab. Björn Ottosson's published matrices. */
  function oklab(c) {
    var r = linear(c[0]), g = linear(c[1]), b = linear(c[2]);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }

  /* How different two painted colours LOOK. Takes [r, g, b] or '#rrggbb'. */
  function deltaE(a, b) {
    var A = oklab(typeof a === 'string' ? (rgb(a) || [0, 0, 0]) : a);
    var B = oklab(typeof b === 'string' ? (rgb(b) || [0, 0, 0]) : b);
    return Math.sqrt((A[0] - B[0]) * (A[0] - B[0]) +
                     (A[1] - B[1]) * (A[1] - B[1]) +
                     (A[2] - B[2]) * (A[2] - B[2]));
  }

  function isSwatch(hex) {
    var h = str(hex);
    for (var i = 0; i < SWATCHES.length; i++) {
      if (SWATCHES[i].hex === h) return true;
    }
    return false;
  }

  function isPart(p) { return PART_INFO.hasOwnProperty(p); }

  function nameOf(hex) {
    for (var i = 0; i < SWATCHES.length; i++) {
      if (SWATCHES[i].hex === hex) return SWATCHES[i].name;
    }
    return hex === GOLD ? 'Champion Gold' : 'That colour';
  }

  function copy(p) { return { nose: p.nose, window: p.window, body: p.body, fire: p.fire }; }

  function same(a, b) {
    return a.nose === b.nose && a.window === b.window && a.body === b.body && a.fire === b.fire;
  }

  /* A single hex off the menu becomes the default rather than being painted.
     Note what this also buys: GOLD is not on the menu, so a hand-edited
     localStorage entry of '#ffc21a' does not survive this function. The crown
     cannot be stored, only worn. */
  function normaliseColour(raw) {
    var h = str(raw);
    return isSwatch(h) ? h : DEFAULT;
  }

  /* ------------------------------------------------------------- the rule */

  /* THE READABILITY INVARIANT. Returns the parts that break it, each with the
     sentence the customiser shows; an empty list means the ship is readable.
     Checked on the PAINTED colours - the renderer's own derivation - because
     the plating a nose sits on is not the body colour, it is the body colour
     pulled most of the way to white, and judging the raw swatches would be
     judging a ship nobody draws.

       body    its rim IS the silhouette: must clear the sky.
       fire    the plume says "engine lit": must clear the sky.
       nose    the one "this end is the front" cue: must read on the plating.
       window  the porthole: must read on the plating.

     With js/rocket.js absent there is no renderer, so there is nothing to
     paint wrongly; only the per-colour sky rule is applied. */
  function readable(paint) {
    var out = [];
    var R = SK.Rocket && SK.Rocket.resolve ? SK.Rocket.resolve(paint) : null;
    var i, part, hex;

    for (i = 0; i < PARTS.length; i++) {
      part = PARTS[i];
      hex = paint[part];
      if (!rgb(hex) || luma(hex) < LUMA_FLOOR) {
        out.push({ part: part, reason: PART_INFO[part].label + ' is too dark to see against space.' });
      }
    }
    if (!R) return out;

    var sky = rgb(SKY);
    function fail(part, reason) {
      for (var k = 0; k < out.length; k++) { if (out[k].part === part) return; }
      out.push({ part: part, reason: reason });
    }
    if (deltaE(R.trim, sky) < SKY_DE) fail('body', 'Body would disappear against space.');
    if (deltaE(R.fire, sky) < SKY_DE) fail('fire', 'Fire would disappear against space.');
    if (deltaE(R.nose, R.hull) < MARK_DE) {
      fail('nose', 'Nose would vanish into this body - the ship would lose its front.');
    }
    if (deltaE(R.glass, R.hull) < MARK_DE) {
      fail('window', 'Window would vanish into this body.');
    }
    return out;
  }

  /* THE GATE. Anything arriving from storage or from the network is UNTRUSTED
     - localStorage is user-editable and the profile row is whatever the last
     client wrote - and it all comes through here before it can be painted.

     Accepts a paint object, a JSON string of one, or a single legacy hex
     (which paints all four parts). Returns a paint that is on the menu AND
     readable, by rules applied in a fixed order so the same input always
     gives the same output:

       1. each part off the menu -> that part's default;
       2. while the combination breaks the rule, the FIRST failing part (in
          PARTS order) -> its default. After step 1 every part is on the
          menu, so body and fire always clear the sky and only nose and
          window can fail here; each is judged against the body alone, so
          resetting one never disturbs the other, and both defaults read on
          every body on the menu;
       3. if it still fails - impossible on today's menu, asserted by the
          test - the whole shipped default.

     A combination that already holds is returned unchanged: the gate corrects
     what is broken and nothing else. */
  function normalise(raw) {
    var src = raw, p = {}, i;
    if (typeof src === 'string') {
      var t = src.trim();
      if (t.charAt(0) === '{') {
        try { src = JSON.parse(t); } catch (e) { src = null; }
      } else {
        src = { nose: t, window: t, body: t, fire: t };
      }
    }
    if (!src || typeof src !== 'object') src = {};
    for (i = 0; i < PARTS.length; i++) p[PARTS[i]] = normaliseColour(src[PARTS[i]]);

    for (i = 0; i <= PARTS.length; i++) {
      var bad = readable(p);
      if (!bad.length) return p;
      p[bad[0].part] = DEFAULTS[bad[0].part];
    }
    return copy(DEFAULTS);
  }

  /* ---------------------------------------------------------------- state */

  var paint = null;          // the player's own paint, lazily loaded
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
    if (paint) return paint;
    var raw = store().get(STORE_KEY, '');
    if (!raw) raw = store().get(LEGACY_KEY, '');
    paint = normalise(raw);
    return paint;
  }

  function save() {
    try { store().set(STORE_KEY, JSON.stringify(load())); } catch (e) { /* ignore */ }
  }

  /* What the renderer asks for: the crown if it is being worn, otherwise the
     player's own paint. Synchronous, never throws, never waits on anything.
     That is the whole reason the network can be slow or dead without the ship
     failing to draw - see the note on setChampionName.

     Returns a shared object on purpose - this runs every frame - and every
     write REPLACES `paint` rather than mutating it, so a caller holding last
     frame's answer is holding a still-true snapshot, not a moving target. */
  function current() {
    return (champion || forced) ? GOLD_PAINT : load();
  }

  /* Why `hex` may not go on `part` given the rest of the current paint, or ''
     when it may. The customiser greys out every swatch this returns a reason
     for, and set() refuses the same ones - one rule, asked in one place. */
  function why(part, hex) {
    if (!isPart(part)) return 'There is no such part.';
    var h = str(hex);
    if (h === GOLD) return 'Gold belongs to whoever is #1.';
    if (!isSwatch(h)) return 'That colour is not on the menu.';
    var next = copy(load());
    next[part] = h;
    var bad = readable(next);
    return bad.length ? bad[0].reason : '';
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
    PARTS: PARTS,
    PART_INFO: PART_INFO,
    DEFAULT: DEFAULT,
    DEFAULTS: copy(DEFAULTS),
    GOLD: GOLD,
    SKY: SKY,
    LUMA_FLOOR: LUMA_FLOOR,
    SKY_DE: SKY_DE,
    MARK_DE: MARK_DE,
    STORE_KEY: STORE_KEY,
    LEGACY_KEY: LEGACY_KEY,

    rgb: rgb,
    luma: luma,
    deltaE: deltaE,
    isSwatch: isSwatch,
    nameOf: nameOf,
    normaliseColour: normaliseColour,
    normalise: normalise,
    readable: readable,
    why: why,

    /* The paint in use, crown included. This is what js/rocket.js paints. */
    current: current,

    /* The player's OWN paint, crown excluded - what the customiser shows as
       selected and what gets persisted. A copy, so the form cannot edit the
       live paint behind the gate's back. */
    saved: function () { return copy(load()); },

    /* The paint as the ACCOUNT should hold it: a part still on the shipped
       default goes up as '' (stored NULL), so the default stays a property
       of the game rather than being frozen into every row that never chose.
       See supabase/schema.sql section 8. */
    toStored: function () {
      var p = copy(load());
      for (var i = 0; i < PARTS.length; i++) {
        if (p[PARTS[i]] === DEFAULTS[PARTS[i]]) p[PARTS[i]] = '';
      }
      return p;
    },

    /* One part. Returns true if anything actually changed, so callers can
       skip a write and a repaint on a no-op tap; false for a no-op AND for a
       refusal - why(part, hex) says which. */
    set: function (part, hex) {
      var h = str(hex);
      if (why(part, h) || load()[part] === h) return false;
      var next = copy(load());
      next[part] = h;
      paint = next;
      save();
      emit();
      return true;
    },

    /* A whole paint at once - the account sync's entry point. Goes through
       the gate, so a server row can never paint what a tap could not. */
    setPaint: function (raw) {
      var next = normalise(raw);
      if (same(next, load())) return false;
      paint = next;
      save();
      emit();
      return true;
    },

    reset: function () { return this.setPaint(DEFAULTS); },

    isDefault: function () { return same(load(), DEFAULTS); },

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
     * js/ui_ship.js calls this with the rank-1 username from the public
     * leaderboard read, and calls it with '' when that read fails, when there
     * is no backend, or when the board comes back empty. There is no timeout
     * and no retry here on purpose: this module never asks, it is only ever
     * told. So every degradation - no config, no network, a 500, a tunnel -
     * arrives as the same state (championName === '') and produces the same
     * behaviour (the player's own paint). The ship has already been drawn
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
       paint and is never persisted, so the worst it can do is show one person
       a gold ship for one page load. See the residual-gap note in
       js/ui_ship.js: this is cosmetic, local, and visible to nobody else. */
    forceChampion: function (on) {
      var next = !!on;
      if (next === forced) return;
      forced = next;
      emit();
    },

    /* Fired whenever the ship's appearance changes, for any reason: a swatch
       tap, a paint arriving from the server, or the crown changing hands
       mid-session. */
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },

    /* For the harness: reload from storage as if the page had just opened. */
    _reload: function () { paint = null; load(); emit(); }
  };

}(typeof window !== 'undefined' ? window : this));
