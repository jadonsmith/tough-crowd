// The big screen's host voice: reads prompts and answers aloud with the
// browser's own speech synthesis. Optional, and it ducks the music while it talks.

import { audio } from "./audio.js";

const synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
let chosen = null;
let gen = 0;

function pickVoice() {
  if (!synth) return null;
  const vs = synth.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang));
  if (!vs.length) return null;
  const score = (v) => {
    let s = 0;
    if (/natural|neural|online/i.test(v.name)) s += 6;
    if (/google/i.test(v.name)) s += 3;
    if (/samantha|daniel|karen|moira|aria|guy|jenny|ryan|sonia|libby/i.test(v.name)) s += 2;
    if (/en[-_](us|gb|au)/i.test(v.lang)) s += 1;
    if (v.localService) s += 0.5;
    return s;
  };
  return vs.sort((a, b) => score(b) - score(a))[0];
}
if (synth) {
  synth.addEventListener?.("voiceschanged", () => (chosen = pickVoice()));
  chosen = pickVoice();
}

function tidy(s) {
  return String(s || "")
    .replace(/_{2,}/g, " blank ")
    .replace(/[✱*]{2,}/g, " bleep ")
    .replace(/\s+/g, " ")
    .trim();
}

export const voice = {
  on: true,
  get ok() {
    return !!synth;
  },
  stop() {
    gen++;
    if (synth) synth.cancel();
    audio.duck(false);
  },
  // Speak lines one after another. Returns a promise that settles when done or stopped.
  say(lines, { rate = 1.04, pitch = 1 } = {}) {
    if (!synth || !this.on) return Promise.resolve();
    this.stop();
    const my = ++gen;
    const list = (Array.isArray(lines) ? lines : [lines]).map(tidy).filter(Boolean);
    if (!list.length) return Promise.resolve();
    if (!chosen) chosen = pickVoice();
    return new Promise((resolve) => {
      let i = 0;
      const next = () => {
        if (my !== gen || i >= list.length) {
          if (my === gen) audio.duck(false);
          return resolve();
        }
        const u = new SpeechSynthesisUtterance(list[i++]);
        if (chosen) u.voice = chosen;
        u.rate = rate;
        u.pitch = pitch;
        u.onend = () => setTimeout(next, 160);
        u.onerror = () => next();
        audio.duck(true);
        synth.speak(u);
      };
      next();
    });
  },
};
