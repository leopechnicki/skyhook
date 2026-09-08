/* SKYHOOK - fully synthesised audio (Web Audio API).
   No sample files => nothing to download, works offline from file://. */
(function (global) {
  'use strict';

  var SK = global.SK || (global.SK = {});

  /* A minor pentatonic ladder - every hook in a combo steps up the scale,
     so a long run literally sounds like it is going somewhere. */
  var LADDER = [220.00, 261.63, 293.66, 349.23, 392.00, 523.25, 587.33, 698.46, 783.99, 1046.50];

  var Audio = {
    ctx: null,
    master: null,
    muted: false,
    ready: false,
    noiseBuf: null,

    init: function () {
      if (this.ready) return true;
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return false;
      try {
        this.ctx = new AC();
      } catch (e) { return false; }

      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.34;
      this.master.connect(this.ctx.destination);

      // 1s of white noise, reused for impacts.
      var len = Math.floor(this.ctx.sampleRate);
      var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;

      this.ready = true;
      return true;
    },

    /* Browsers start the context suspended until a real user gesture. */
    resume: function () {
      if (!this.ready && !this.init()) return;
      if (this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) {} }
    },

    setMuted: function (m) {
      this.muted = !!m;
      if (this.master) {
        var t = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(t);
        this.master.gain.setTargetAtTime(this.muted ? 0 : 0.34, t, 0.02);
      }
    },

    _env: function (dest, t0, attack, decay, peak) {
      var g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
      g.connect(dest || this.master);
      return g;
    },

    _tone: function (type, f0, f1, t0, attack, decay, peak, dest) {
      var o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t0);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + attack + decay);
      var g = this._env(dest, t0, attack, decay, peak);
      o.connect(g);
      o.start(t0);
      o.stop(t0 + attack + decay + 0.05);
      return o;
    },

    _noise: function (t0, dur, peak, freq, q) {
      var src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      var f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(freq, t0);
      f.Q.value = q || 1;
      var g = this._env(null, t0, 0.005, dur, peak);
      src.connect(f); f.connect(g);
      src.start(t0);
      src.stop(t0 + dur + 0.08);
    },

    hook: function (step, tight) {
      if (!this.ready || this.muted) return;
      var t = this.ctx.currentTime;
      var f = LADDER[SK.clamp(step | 0, 0, LADDER.length - 1)];
      this._tone('triangle', f, f, t, 0.004, 0.17, 0.55);
      this._tone('sine', f * 2, f * 2, t, 0.004, 0.10, 0.22);
      if (tight) {
        this._tone('sine', f * 4, f * 6, t + 0.01, 0.004, 0.14, 0.16);
        this._noise(t, 0.06, 0.10, 5200, 3);
      }
    },

    shard: function () {
      if (!this.ready || this.muted) return;
      var t = this.ctx.currentTime;
      this._tone('sine', 1180, 1850, t, 0.003, 0.09, 0.30);
      this._tone('sine', 1770, 2600, t + 0.05, 0.003, 0.09, 0.16);
    },

    warn: function () {
      if (!this.ready || this.muted) return;
      var t = this.ctx.currentTime;
      this._tone('square', 300, 300, t, 0.003, 0.055, 0.13);
    },

    snap: function () {
      if (!this.ready || this.muted) return;
      var t = this.ctx.currentTime;
      this._tone('sawtooth', 180, 70, t, 0.003, 0.16, 0.24);
      this._noise(t, 0.11, 0.13, 1400, 0.8);
    },

    death: function () {
      if (!this.ready || this.muted) return;
      var t = this.ctx.currentTime;
      this._tone('sawtooth', 300, 42, t, 0.006, 0.60, 0.44);
      this._tone('square', 150, 30, t + 0.02, 0.006, 0.50, 0.20);
      this._noise(t, 0.34, 0.26, 700, 0.6);
    },

    start: function () {
      if (!this.ready || this.muted) return;
      var t = this.ctx.currentTime;
      var seq = [261.63, 392.00, 523.25, 783.99];
      for (var i = 0; i < seq.length; i++) {
        this._tone('triangle', seq[i], seq[i], t + i * 0.055, 0.004, 0.16, 0.34);
      }
    },

    best: function () {
      if (!this.ready || this.muted) return;
      var t = this.ctx.currentTime;
      var seq = [523.25, 659.25, 783.99, 1046.50, 1318.51];
      for (var i = 0; i < seq.length; i++) {
        this._tone('triangle', seq[i], seq[i], t + i * 0.075, 0.004, 0.26, 0.30);
      }
    },

    ui: function () {
      if (!this.ready || this.muted) return;
      var t = this.ctx.currentTime;
      this._tone('square', 880, 880, t, 0.002, 0.045, 0.14);
    }
  };

  SK.Audio = Audio;

}(window));
