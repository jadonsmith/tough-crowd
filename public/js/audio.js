// Every sound in Tough Crowd is synthesised here with Web Audio: the rimshot,
// claps, splats, stamps, a sad trombone, and a little walking-bass lounge loop
// for the big screen while everyone writes. No audio files.

let ctx = null;
let master = null;
let sfxBus = null;
let musicBus = null;
let noiseBuf = null;
let muted = false;

function init() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.9;
  master.connect(comp);
  comp.connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.85;
  sfxBus.connect(master);
  musicBus = ctx.createGain();
  musicBus.gain.value = 0;
  musicBus.connect(master);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return true;
}

const live = () => ctx && ctx.state === "running" && !muted;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function env(g, t, { a = 0.005, peak = 0.3, d = 0.2, sustain = 0, r = 0.05, hold = 0 } = {}) {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
  if (hold) g.gain.setValueAtTime(peak, t + a + hold);
  const s = Math.max(0.0001, sustain);
  g.gain.exponentialRampToValueAtTime(s, t + a + hold + d);
  if (sustain > 0) g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + d + r);
}

function tone({ f = 440, f2 = null, type = "sine", at = 0, dur = 0.2, vol = 0.2, a = 0.004, bus = sfxBus, lp = null, detune = 0 }) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  if (detune) o.detune.value = detune;
  const g = ctx.createGain();
  env(g, t, { a, peak: vol, d: dur });
  let node = o;
  if (lp) {
    const fl = ctx.createBiquadFilter();
    fl.type = "lowpass";
    fl.frequency.value = lp;
    o.connect(fl);
    node = fl;
  }
  node.connect(g);
  g.connect(bus);
  o.start(t);
  o.stop(t + a + dur + 0.05);
  return o;
}

function noise({ at = 0, dur = 0.2, vol = 0.2, type = "bandpass", f = 1000, f2 = null, q = 1, a = 0.003, bus = sfxBus }) {
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const fl = ctx.createBiquadFilter();
  fl.type = type;
  fl.frequency.setValueAtTime(f, t);
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
  fl.Q.value = q;
  const g = ctx.createGain();
  env(g, t, { a, peak: vol, d: dur });
  src.connect(fl);
  fl.connect(g);
  g.connect(bus);
  src.start(t, Math.random() * 1.5);
  src.stop(t + a + dur + 0.05);
}

// Metallic cymbal: a bank of detuned squares, band-passed high.
function metal({ at = 0, dur = 1, vol = 0.15, f = 9000, bus = sfxBus }) {
  const t = ctx.currentTime + at;
  const fl = ctx.createBiquadFilter();
  fl.type = "bandpass";
  fl.frequency.value = f;
  fl.Q.value = 0.8;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 6000;
  const g = ctx.createGain();
  env(g, t, { a: 0.002, peak: vol, d: dur });
  fl.connect(hp);
  hp.connect(g);
  g.connect(bus);
  for (const r of [2, 3, 4.16, 5.43, 6.79, 8.21]) {
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = 40 * r * 1.7;
    o.connect(fl);
    o.start(t);
    o.stop(t + dur + 0.1);
  }
}

export const audio = {
  get ok() {
    return !!ctx;
  },
  unlock() {
    if (!ctx && !init()) return;
    if (ctx.state !== "running") ctx.resume().catch(() => {});
  },
  get muted() {
    return muted;
  },
  setMuted(m) {
    muted = !!m;
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.05);
  },

  rimshot() {
    if (!live()) return;
    tone({ f: 210, f2: 130, dur: 0.16, vol: 0.5 });
    noise({ dur: 0.05, vol: 0.18, f: 1600 });
    tone({ f: 165, f2: 100, at: 0.17, dur: 0.2, vol: 0.5 });
    noise({ at: 0.17, dur: 0.05, vol: 0.15, f: 1300 });
    tone({ f: 130, f2: 45, at: 0.4, dur: 0.3, vol: 0.55 });
    noise({ at: 0.4, dur: 0.18, vol: 0.22, f: 2200, q: 0.6 });
    metal({ at: 0.4, dur: 1.5, vol: 0.12 });
    noise({ at: 0.4, dur: 1.3, vol: 0.09, type: "highpass", f: 7000 });
  },
  pop(pitch = 0) {
    if (!live()) return;
    const k = Math.pow(2, pitch / 12);
    tone({ f: 420 * k, f2: 900 * k, dur: 0.09, vol: 0.22 });
    tone({ f: 700 * k, f2: 1300 * k, at: 0.05, dur: 0.07, vol: 0.12 });
  },
  tap() {
    if (!live()) return;
    tone({ f: 880, type: "triangle", dur: 0.05, vol: 0.09 });
  },
  tick(hi = false) {
    if (!live()) return;
    tone({ f: hi ? 1760 : 1320, type: "square", dur: 0.025, vol: 0.045, lp: 4000 });
  },
  whoosh() {
    if (!live()) return;
    noise({ dur: 0.45, vol: 0.16, f: 350, f2: 3200, q: 1.4, a: 0.16 });
  },
  ding(step = 0) {
    if (!live()) return;
    const f = 784 * Math.pow(2, step / 12);
    tone({ f, dur: 1.1, vol: 0.2 });
    tone({ f: f * 2.76, dur: 0.5, vol: 0.05 });
    tone({ f: f * 5.4, dur: 0.2, vol: 0.02 });
  },
  vote() {
    if (!live()) return;
    tone({ f: 660, f2: 990, type: "triangle", dur: 0.08, vol: 0.12 });
  },
  chip(step = 0) {
    if (!live()) return;
    const f = 520 * Math.pow(2, (step % 12) / 12);
    tone({ f, type: "triangle", dur: 0.08, vol: 0.12 });
    noise({ dur: 0.02, vol: 0.05, f: 4000 });
  },
  stamp() {
    if (!live()) return;
    tone({ f: 110, f2: 48, dur: 0.22, vol: 0.55 });
    noise({ dur: 0.08, vol: 0.25, f: 900, q: 0.5 });
  },
  splat() {
    if (!live()) return;
    noise({ dur: 0.28, vol: 0.38, type: "lowpass", f: 1400, f2: 300 });
    tone({ f: 320, f2: 60, dur: 0.2, vol: 0.3 });
    noise({ at: 0.03, dur: 0.12, vol: 0.12, f: 2600, q: 2 });
  },
  applause(sec = 2.6, vol = 0.12) {
    if (!live()) return;
    const n = Math.floor(sec * 70);
    for (let i = 0; i < n; i++) {
      const at = Math.random() * sec;
      const shape = Math.sin((at / sec) * Math.PI); // swell then fade
      noise({ at, dur: 0.02 + Math.random() * 0.04, vol: vol * (0.35 + Math.random() * 0.65) * (0.3 + shape * 0.7), f: 900 + Math.random() * 1800, q: 0.9 });
    }
  },
  trombone() {
    if (!live()) return;
    const notes = [58, 57, 56, 55];
    notes.forEach((m, i) => {
      const at = i * 0.42;
      const dur = i === 3 ? 1.1 : 0.36;
      const t = ctx.currentTime + at;
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(mtof(m - 12), t);
      if (i === 3) {
        const lfo = ctx.createOscillator();
        const lg = ctx.createGain();
        lfo.frequency.value = 5.5;
        lg.gain.value = 3;
        lfo.connect(lg);
        lg.connect(o.frequency);
        lfo.start(t + 0.2);
        lfo.stop(t + dur + 0.1);
      }
      const fl = ctx.createBiquadFilter();
      fl.type = "lowpass";
      fl.Q.value = 5;
      fl.frequency.setValueAtTime(350, t);
      fl.frequency.exponentialRampToValueAtTime(1500, t + 0.12);
      fl.frequency.exponentialRampToValueAtTime(500, t + dur);
      const g = ctx.createGain();
      env(g, t, { a: 0.03, peak: 0.16, d: dur });
      o.connect(fl);
      fl.connect(g);
      g.connect(sfxBus);
      o.start(t);
      o.stop(t + dur + 0.1);
    });
  },
  fanfare() {
    if (!live()) return;
    const stab = (ms, at, dur, vol) => {
      for (const m of ms) {
        for (const det of [-7, 7]) {
          const t = ctx.currentTime + at;
          const o = ctx.createOscillator();
          o.type = "sawtooth";
          o.frequency.value = mtof(m);
          o.detune.value = det;
          const fl = ctx.createBiquadFilter();
          fl.type = "lowpass";
          fl.frequency.setValueAtTime(700, t);
          fl.frequency.exponentialRampToValueAtTime(3200, t + 0.06);
          fl.frequency.exponentialRampToValueAtTime(1400, t + dur);
          const g = ctx.createGain();
          env(g, t, { a: 0.02, peak: vol, d: dur });
          o.connect(fl);
          fl.connect(g);
          g.connect(sfxBus);
          o.start(t);
          o.stop(t + dur + 0.1);
        }
      }
    };
    stab([60, 64, 67], 0, 0.16, 0.05);
    stab([60, 64, 67], 0.2, 0.16, 0.05);
    stab([62, 65, 69], 0.4, 0.16, 0.05);
    stab([64, 67, 72], 0.62, 1.3, 0.06);
    tone({ f: mtof(36), f2: mtof(36), type: "triangle", at: 0.62, dur: 1.2, vol: 0.25 });
    metal({ at: 0.62, dur: 1.6, vol: 0.08 });
  },
  drumroll(sec = 1.6) {
    if (!live()) return;
    const n = Math.floor(sec * 26);
    for (let i = 0; i < n; i++) {
      const at = (i / n) * sec;
      noise({ at, dur: 0.05, vol: 0.05 + (i / n) * 0.13, f: 1800, q: 0.7 });
    }
  },
  beep(hi = false) {
    if (!live()) return;
    tone({ f: hi ? 1046 : 784, type: "triangle", dur: 0.12, vol: 0.14 });
  },
  buzzer() {
    if (!live()) return;
    tone({ f: 140, type: "sawtooth", dur: 0.45, vol: 0.1, lp: 900 });
    tone({ f: 147, type: "sawtooth", dur: 0.45, vol: 0.08, lp: 900 });
  },

  // ---- music: a small lounge loop (walking bass, ride, brushes, comping) ----
  startMusic() {
    if (!ctx || music.on) return;
    music.on = true;
    music.next = ctx.currentTime + 0.12;
    music.beat = 0;
    musicBus.gain.cancelScheduledValues(ctx.currentTime);
    musicBus.gain.setTargetAtTime(music.level, ctx.currentTime, 0.6);
    clearInterval(music.timer);
    music.timer = setInterval(schedule, 30);
  },
  stopMusic(fade = 0.5) {
    if (!ctx || !music.on) return;
    music.on = false;
    musicBus.gain.cancelScheduledValues(ctx.currentTime);
    musicBus.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
    const t = music.timer;
    setTimeout(() => {
      if (!music.on) clearInterval(t);
    }, fade * 1000 + 300);
  },
  duck(on) {
    if (!ctx || !music.on) return;
    musicBus.gain.setTargetAtTime(on ? music.level * 0.35 : music.level, ctx.currentTime, 0.15);
  },
  get musicOn() {
    return music.on;
  },
};

const music = { on: false, timer: null, next: 0, beat: 0, bpm: 104, level: 0.5 };

// Dm9 | G13 | Cmaj9 | A7b13, two walking lines that alternate every four bars.
const CHORDS = [
  [53, 57, 60, 64],
  [53, 59, 64],
  [52, 55, 59, 62],
  [55, 61, 65],
];
const WALK = [
  [38, 40, 41, 42, 43, 47, 50, 49, 48, 47, 45, 43, 45, 44, 41, 39],
  [38, 41, 45, 48, 47, 43, 41, 38, 36, 40, 43, 47, 45, 43, 40, 37],
];
const COMP = [
  [[1, 0.66, 0.25], [3, 0, 0.2]],
  [[0, 0.66, 0.22], [2, 0.66, 0.22]],
  [[1, 0, 0.25], [2, 0.66, 0.18], [3, 0.66, 0.2]],
  [[0, 0, 0.3]],
];

function schedule() {
  if (!music.on || !ctx) return;
  const spb = 60 / music.bpm;
  while (music.next < ctx.currentTime + 0.25) {
    const b = music.beat;
    const t = music.next;
    const bar = Math.floor(b / 4) % 4;
    const inBar = b % 4;
    const line = WALK[Math.floor(b / 16) % 2];
    bass(mtof(line[b % 16]), t, spb * 0.95);
    // ride: every beat, plus the swung "and" of 2 and 4
    ride(t, inBar % 2 ? 0.05 : 0.07);
    if (inBar % 2 === 1) {
      ride(t + spb * 0.66, 0.04);
      brush(t, 0.05);
      chick(t);
    }
    if (inBar === 0) {
      const pat = COMP[(Math.floor(b / 4) * 7 + bar) % COMP.length];
      for (const [beatIn, frac, len] of pat) keys(CHORDS[bar], t + (beatIn + frac) * spb, len * 3.2);
    }
    music.beat++;
    music.next += spb;
  }
}

function bass(f, t, len) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.34, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.14);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  const fl = ctx.createBiquadFilter();
  fl.type = "lowpass";
  fl.frequency.setValueAtTime(1100, t);
  fl.frequency.exponentialRampToValueAtTime(380, t + 0.18);
  fl.connect(g);
  g.connect(musicBus);
  for (const [type, mul, v] of [["triangle", 1, 1], ["sine", 0.5, 0.6]]) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f * mul;
    const og = ctx.createGain();
    og.gain.value = v;
    o.connect(og);
    og.connect(fl);
    o.start(t);
    o.stop(t + len + 0.05);
  }
}

function ride(t, vol) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const fl = ctx.createBiquadFilter();
  fl.type = "highpass";
  fl.frequency.value = 7500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  src.connect(fl);
  fl.connect(g);
  g.connect(musicBus);
  src.start(t, Math.random());
  src.stop(t + 0.35);
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.value = 5200 + Math.random() * 60;
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, t);
  og.gain.exponentialRampToValueAtTime(vol * 0.22, t + 0.003);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  o.connect(og);
  og.connect(musicBus);
  o.start(t);
  o.stop(t + 0.55);
}

function brush(t, vol) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const fl = ctx.createBiquadFilter();
  fl.type = "bandpass";
  fl.frequency.value = 2600;
  fl.Q.value = 0.6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.04);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
  src.connect(fl);
  fl.connect(g);
  g.connect(musicBus);
  src.start(t, Math.random());
  src.stop(t + 0.3);
}

function chick(t) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const fl = ctx.createBiquadFilter();
  fl.type = "highpass";
  fl.frequency.value = 9000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.03, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  src.connect(fl);
  fl.connect(g);
  g.connect(musicBus);
  src.start(t, Math.random());
  src.stop(t + 0.07);
}

function keys(chord, t, len) {
  const fl = ctx.createBiquadFilter();
  fl.type = "lowpass";
  fl.frequency.value = 2200;
  fl.connect(musicBus);
  for (const m of chord) {
    const f = mtof(m);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.055, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.02, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    g.connect(fl);
    for (const [mul, v, det] of [[1, 1, -4], [1, 0.6, 5], [2, 0.18, 0], [3, 0.05, 0]]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f * mul;
      o.detune.value = det;
      const og = ctx.createGain();
      og.gain.value = v;
      o.connect(og);
      og.connect(g);
      o.start(t);
      o.stop(t + len + 0.05);
    }
  }
}
