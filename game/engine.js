// Tough Crowd game rules.
//
// Pure logic: no sockets and no timers. The server calls tick(now) a few
// times a second and the action methods with its own clock, so the tests can
// play whole games on a fake one. Who is connected comes from a `presence`
// object the server supplies.
//
// A show is up to three acts:
//   h2h     Head to Head. Every player gets two prompts, each shared with a
//           different rival. The room votes on each duel.
//   hot     The Hot Seat. One player judges a prompt about themselves. The
//           others answer, the judge picks a favourite, then guesses who wrote it.
//   closer  The Closer. One prompt for everyone. Give one mic to a favourite and,
//           if you like, throw one tomato.
// For any prompt you can write an answer or play a card from your hand.

import { PROMPTS, CARDS } from "./content.js";
import { cleanText } from "./filter.js";

export const ACT_ORDER = ["h2h", "hot", "closer"];

export const ACT_INFO = {
  h2h: {
    title: "Head to Head",
    tag: "Two of you, one prompt",
    rules: [
      "You get two prompts. Each one is shared with a different rival.",
      "Write something funny, or play a card from your hand.",
      "The rest of the room votes. Sweep every vote and you killed it.",
    ],
    say: "Act one. Head to head. You and a rival answer the same prompt, and everyone else votes.",
  },
  hot: {
    title: "The Hot Seat",
    tag: "One judge, everyone else plays to them",
    rules: [
      "One player sits in the hot seat, and the prompt is all about them.",
      "Everyone else answers. The judge picks a favourite.",
      "Then the judge guesses who wrote it. Guess right for bonus points.",
    ],
    say: "Act two. The hot seat. Answer a prompt about the judge, and win them over.",
  },
  closer: {
    title: "The Closer",
    tag: "One prompt. Everybody. Biggest points of the night",
    rules: [
      "Everyone answers the same final prompt.",
      "Hand your mic to your favourite. Throw a tomato if you must.",
      "The most mics closes the show.",
    ],
    say: "And now, the closer. One last prompt for everybody. Biggest points of the night.",
  },
};

// The act cards mention writing and cards; trim that to the room's answer mode.
const ANSWER_LINE = {
  mix: "Write something funny, or play a card from your hand.",
  cards: "Play the best card from your hand. No writing this time.",
  write: "Write the funniest thing you can think of.",
};
export function infoFor(act, mode = "mix") {
  const info = ACT_INFO[act];
  if (!info) return info;
  return { ...info, rules: info.rules.map((r) => (r === ANSWER_LINE.mix ? ANSWER_LINE[mode] || r : r)) };
}

// Durations at normal pace (ms). PACED ones stretch or shrink with the pace setting.
export const T = {
  intro: 7500,
  h2hWrite: 90000,
  vote: 20000,
  voteMin: 5500,
  reveal: 7500,
  sweepExtra: 1500,
  scores: 8500,
  hotWrite: 50000,
  hotPick: 45000,
  hotPickGrace: 5000,
  hotGuess: 20000,
  hotReveal: 9000,
  closerWrite: 75000,
  closerVote: 40000,
  closerVoteMin: 6000,
  closerRevealBase: 6000,
  closerRevealStep: 2200,
};
const PACED = new Set(["h2hWrite", "vote", "hotWrite", "hotPick", "hotGuess", "closerWrite", "closerVote"]);
export const PACE = { relaxed: 1.5, normal: 1, quick: 0.65 };

export const PTS = {
  duelPot: 600, // split by vote share
  duelWin: 100,
  duelSweep: 200, // every vote, and at least two of them
  judgePick: 400,
  crowdPot: 200, // split by the crowd's votes in the Hot Seat
  guess: 200,
  closerPot: 1500, // split by mic share
  closerTop: 250,
};

export const HAND = 6;
export const REDRAWS = 1; // per act
export const HOT_MAX = 6; // hot seat turns at most
export const TEXT_MAX = 70;

const WRITE_KINDS = new Set(["write", "hot-write", "closer-write"]);

// ---------- helpers ----------
export function shuffle(a, rng = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickOne(a, rng) {
  return a[Math.floor(rng() * a.length)];
}
const round10 = (x) => Math.round(x / 10) * 10;

// Duel order: shuffle a few times and keep the one where the fewest
// back-to-back duels share a player, so nobody is up twice in a row.
function duelOrder(ms, rng) {
  let best = null;
  let bestBad = Infinity;
  for (let k = 0; k < 24 && bestBad > 0; k++) {
    const o = shuffle(ms.map((_, i) => i), rng);
    let bad = 0;
    for (let i = 1; i < o.length; i++) {
      const p = ms[o[i - 1]];
      const q = ms[o[i]];
      if (p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) bad++;
    }
    if (bad < bestBad) {
      best = o;
      bestBad = bad;
    }
  }
  return best || [];
}

// ---------- shared decks (live on the room, so they carry across games) ----------
export class CardDeck {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.pile = shuffle(CARDS.map((_, i) => i), rng);
    this.used = [];
  }
  draw() {
    if (!this.pile.length) {
      this.pile = shuffle(this.used, this.rng);
      this.used = [];
    }
    return this.pile.length ? this.pile.pop() : null;
  }
  deal(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = this.draw();
      if (c != null) out.push(c);
    }
    return out;
  }
  discard(c) {
    if (c != null) this.used.push(c);
  }
  discardMany(cs) {
    for (const c of cs) this.discard(c);
  }
}

export class PromptPool {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.used = { h2h: new Set(), hot: new Set(), closer: new Set() };
  }
  draw(kind, { allowPlayer = true } = {}) {
    const list = PROMPTS[kind];
    const fits = (i) => allowPlayer || !list[i].includes("{player}");
    let cands = list.map((_, i) => i).filter((i) => fits(i) && !this.used[kind].has(i));
    if (!cands.length) {
      this.used[kind].clear();
      cands = list.map((_, i) => i).filter(fits);
    }
    const i = pickOne(cands, this.rng);
    this.used[kind].add(i);
    return list[i];
  }
}

// ---------- awards ----------
const times = (n) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const fmt = (n) => n.toLocaleString("en-US");
const AWARDS = [
  { id: "showstopper", stat: "sweeps", min: 1, title: "Showstopper", desc: (n) => `Swept every vote ${times(n)}` },
  { id: "mind", stat: "mindReads", min: 1, title: "Mind Reader", desc: (n) => `Guessed the writer ${times(n)} from the Hot Seat` },
  { id: "pet", stat: "judgeWins", min: 2, title: "Judge's Pet", desc: (n) => `Picked by the judge ${times(n)}` },
  { id: "shark", stat: "cardPts", min: 400, title: "Card Shark", desc: (n) => `${fmt(n)} points from cards in hand` },
  { id: "pen", stat: "writePts", min: 400, title: "Golden Pen", desc: (n) => `${fmt(n)} points from written answers` },
  { id: "tomato", stat: "tomatoes", min: 1, title: "Tomato Magnet", desc: (n) => `Caught ${n} tomato${n === 1 ? "" : "es"} in the Closer` },
  { id: "fave", stat: "votes", min: 4, title: "Crowd Favourite", desc: (n) => `${n} votes over the night` },
  { id: "tough", stat: "bombs", min: 2, title: "Tough Crowd", desc: (n) => `${n} answers the room just didn't get` },
];

// ---------- the game ----------
export class Game {
  /**
   * @param {object} o
   * @param {{id:string,name:string}[]} o.players  seat order
   * @param {{acts:object, answers:'mix'|'cards'|'write', pace:string, family:boolean}} o.settings
   * @param {CardDeck} o.deck
   * @param {PromptPool} o.prompts
   * @param {{present(id,now):boolean, audience(now):string[], isAudience(id,now):boolean}} o.presence
   */
  constructor({ players, settings, deck, prompts, presence, rng = Math.random, timeScale = 1, now = Date.now() }) {
    this.rng = rng;
    this.settings = settings;
    this.deck = deck;
    this.prompts = prompts;
    this.presence = presence;
    this.ts = timeScale;
    this.pace = PACE[settings.pace] || 1;
    this.mode = ["mix", "cards", "write"].includes(settings.answers) ? settings.answers : "mix";
    this.family = !!settings.family;
    this.players = players.map((p) => ({ id: p.id, name: p.name, left: false }));
    this.byId = new Map(this.players.map((p) => [p.id, p]));
    this.scores = new Map();
    this.stats = new Map();
    this.hands = new Map();
    this.redraws = new Map();
    for (const p of this.players) {
      this.scores.set(p.id, 0);
      this.stats.set(p.id, { votes: 0, sweeps: 0, bombs: 0, judgeWins: 0, mindReads: 0, cardPts: 0, writePts: 0, tomatoes: 0 });
      this.hands.set(p.id, this.deck.deal(HAND));
    }
    this.acts = ACT_ORDER.filter((a) => settings.acts && settings.acts[a]);
    if (!this.acts.length) this.acts = ACT_ORDER.slice();
    this.actIdx = -1;
    this.act = null;
    this.phase = null;
    this.version = 0;
    this.prevScores = new Map(this.scores);
    this.h2h = null;
    this.hot = null;
    this.closer = null;
    this.final = null;
    this.nextAct(now);
  }

  // ---- small things ----
  dur(key) {
    return Math.max(1, Math.round(T[key] * (PACED.has(key) ? this.pace : 1) * this.ts));
  }
  setPhase(kind, dur, now, data = {}) {
    this.phase = { kind, act: this.act, startedAt: now, dur: dur ?? null, endsAt: dur == null ? null : now + dur, ...data };
    this.version++;
  }
  activeIds() {
    return this.players.filter((p) => !p.left).map((p) => p.id);
  }
  isActive(id) {
    const p = this.byId.get(id);
    return !!p && !p.left;
  }
  present(id, now) {
    return this.isActive(id) && this.presence.present(id, now);
  }
  audience(now) {
    return this.presence.audience(now).filter((id) => !this.byId.has(id));
  }
  isAudience(id, now) {
    return !this.byId.has(id) && this.presence.isAudience(id, now);
  }
  name(id) {
    return this.byId.get(id)?.name ?? "Someone";
  }
  hand(id) {
    return this.hands.get(id) || [];
  }

  markLeft(id, now) {
    const p = this.byId.get(id);
    if (!p || p.left) return;
    p.left = true;
    this.deck.discardMany(this.hand(id));
    this.hands.set(id, []);
    this.version++;
    this.checkEarly(now);
  }

  // Cards still in hands go back to the room deck when a game ends.
  returnCards() {
    for (const [id, h] of this.hands) {
      this.deck.discardMany(h);
      this.hands.set(id, []);
    }
  }

  drawPrompt(kind, { others = [], judge = null } = {}) {
    let text = this.prompts.draw(kind, { allowPlayer: others.length > 0 });
    if (text.includes("{player}")) {
      const who = this.name(pickOne(others, this.rng));
      text = text.replaceAll("{player}", () => who);
    }
    if (judge != null) {
      const who = this.name(judge);
      text = text.replaceAll("{judge}", () => who);
    }
    return text;
  }

  // ---- flow ----
  nextAct(now) {
    this.actIdx++;
    for (const p of this.players) this.redraws.set(p.id, REDRAWS);
    if (this.actIdx >= this.acts.length || this.activeIds().length < 2) return this.finish(now);
    this.act = this.acts[this.actIdx];
    this.prevScores = new Map(this.scores);
    this.setPhase("intro", this.dur("intro"), now);
  }

  beginAct(now) {
    if (this.act === "h2h") return this.h2hBegin(now);
    if (this.act === "hot") return this.hotBegin(now);
    return this.closerBegin(now);
  }

  goScores(now) {
    if (this.actIdx >= this.acts.length - 1) return this.finish(now);
    this.setPhase("scores", this.dur("scores"), now, { next: this.acts[this.actIdx + 1] });
  }

  finish(now) {
    this.act = null;
    this.final = { ranking: this.ranking(), awards: this.awards() };
    this.setPhase("final", null, now);
  }

  tick(now) {
    if (!this.phase) return false;
    const v = this.version;
    const ph = this.phase;
    if (ph.endsAt != null && now >= ph.endsAt) this.timeout(now);
    else this.checkEarly(now);
    return v !== this.version;
  }

  timeout(now) {
    switch (this.phase.kind) {
      case "intro":
        return this.beginAct(now);
      case "write":
        return this.h2hCloseWrite(now);
      case "vote":
        return this.h2hReveal(now);
      case "reveal":
        return this.h2hNextDuel(now);
      case "scores":
        return this.nextAct(now);
      case "hot-write":
        return this.hotCloseWrite(now);
      case "hot-pick":
        return this.hotClosePick(now);
      case "hot-guess":
        return this.hotReveal(now);
      case "hot-reveal":
        return this.hotNextTurn(now);
      case "closer-write":
        return this.closerCloseWrite(now);
      case "closer-vote":
        return this.closerReveal(now);
      case "closer-reveal":
        return this.finish(now);
    }
  }

  // End a phase early once nobody is left to wait for.
  checkEarly(now) {
    const ph = this.phase;
    if (!ph) return;
    const elapsed = now - ph.startedAt;
    switch (ph.kind) {
      case "write":
        if (!this.h2hWaiting(now).length) this.h2hCloseWrite(now);
        break;
      case "vote": {
        if (elapsed < this.dur("voteMin")) break;
        const m = this.curDuel();
        if (this.duelVoters(m, now).every((id) => m.votes.has(id))) this.h2hReveal(now);
        break;
      }
      case "hot-write":
        if (!this.hotWaiting(now).length) this.hotCloseWrite(now);
        break;
      case "hot-pick": {
        const t = this.curTurn();
        if (t.pick == null) {
          if (!this.present(t.judge, now)) this.hotClosePick(now);
          break;
        }
        const crowdDone = this.hotCrowdVoters(now).every((id) => t.crowd.has(id));
        if (crowdDone || now - t.pickAt >= this.dur("hotPickGrace")) this.hotClosePick(now);
        break;
      }
      case "hot-guess":
        if (!this.present(this.curTurn().judge, now)) this.hotReveal(now);
        break;
      case "closer-write":
        if (!this.closerWaiting(now).length) this.closerCloseWrite(now);
        break;
      case "closer-vote": {
        if (elapsed < this.dur("closerVoteMin")) break;
        const C = this.closer;
        if (this.closerVoters(now).every((id) => C.votes.has(id) || !this.closerCanVote(id))) this.closerReveal(now);
        break;
      }
    }
  }

  // ---- answers ----
  draw(id) {
    const c = this.deck.draw();
    if (c != null) this.hands.get(id)?.push(c);
  }

  makeAnswer(id, input, now) {
    if (!input || typeof input !== "object") return null;
    const at = now - this.phase.startedAt;
    if (input.card != null && this.mode !== "write") {
      const h = this.hand(id);
      const i = h.indexOf(input.card);
      if (i < 0) return null;
      h.splice(i, 1);
      this.deck.discard(input.card);
      this.draw(id);
      return { pid: id, text: CARDS[input.card], card: input.card, auto: false, at };
    }
    if (typeof input.text === "string" && this.mode !== "cards") {
      const text = cleanText(input.text, { family: this.family, max: TEXT_MAX });
      if (!text) return null;
      return { pid: id, text, card: null, auto: false, at };
    }
    return null;
  }

  // Out of time (or gone): play a random card from their hand for them.
  autoAnswer(id) {
    let h = this.hand(id);
    if (!h.length) {
      this.draw(id);
      h = this.hand(id);
    }
    let card;
    if (h.length) {
      card = h.splice(Math.floor(this.rng() * h.length), 1)[0];
      if (this.isActive(id)) this.draw(id);
    } else {
      card = this.deck.draw() ?? 0;
    }
    this.deck.discard(card);
    return { pid: id, text: CARDS[card], card, auto: true, at: null };
  }

  answer(id, slot, input, now) {
    const ph = this.phase;
    if (!ph || !this.isActive(id)) return false;
    let target = null;
    if (ph.kind === "write") {
      const m = this.h2h.ms.find((x) => x.id === slot);
      if (!m || (m.a !== id && m.b !== id) || m.ans.has(id)) return false;
      target = m.ans;
    } else if (ph.kind === "hot-write") {
      const t = this.curTurn();
      if (slot !== `h${this.hot.cursor}` || id === t.judge || !t.answerers.includes(id) || t.ans.has(id)) return false;
      target = t.ans;
    } else if (ph.kind === "closer-write") {
      const C = this.closer;
      if (slot !== "c" || !C.writers.includes(id) || C.ans.has(id)) return false;
      target = C.ans;
    } else return false;
    const a = this.makeAnswer(id, input, now);
    if (!a) return false;
    target.set(id, a);
    this.version++;
    this.checkEarly(now);
    return true;
  }

  redraw(id, now) {
    if (!this.isActive(id) || this.mode === "write") return false;
    if (!WRITE_KINDS.has(this.phase?.kind)) return false;
    const left = this.redraws.get(id) || 0;
    if (left <= 0) return false;
    this.redraws.set(id, left - 1);
    const old = this.hand(id);
    this.hands.set(id, this.deck.deal(HAND));
    this.deck.discardMany(old);
    this.version++;
    return true;
  }

  award(id, pts, ans, { votes = 0, sweep = false, bomb = false, judgeWin = false } = {}) {
    if (!this.scores.has(id)) return;
    this.scores.set(id, this.scores.get(id) + pts);
    const s = this.stats.get(id);
    s.votes += votes;
    if (sweep) s.sweeps++;
    if (bomb) s.bombs++;
    if (judgeWin) s.judgeWins++;
    if (ans) {
      if (ans.card != null) s.cardPts += pts;
      else s.writePts += pts;
    }
  }

  // ---- Act I: Head to Head ----
  h2hBegin(now) {
    const ids = shuffle(this.activeIds(), this.rng);
    const n = ids.length;
    const pairs = n === 2 ? [[ids[0], ids[1]]] : ids.map((a, i) => [a, ids[(i + 1) % n]]);
    const ms = pairs.map(([a, b], i) => ({
      id: `m${i}`,
      prompt: this.drawPrompt("h2h", { others: ids.filter((x) => x !== a && x !== b) }),
      a,
      b,
      ans: new Map(),
      votes: new Map(),
      result: null,
    }));
    this.h2h = { ms, order: duelOrder(ms, this.rng), cursor: -1 };
    this.setPhase("write", this.dur("h2hWrite"), now);
  }
  h2hMine(id) {
    return this.h2h.ms.filter((m) => m.a === id || m.b === id);
  }
  h2hPending(id) {
    return this.h2hMine(id).filter((m) => !m.ans.has(id));
  }
  h2hWaiting(now) {
    return this.activeIds().filter((id) => this.presence.present(id, now) && this.h2hPending(id).length > 0);
  }
  h2hCloseWrite(now) {
    for (const m of this.h2h.ms) for (const id of [m.a, m.b]) if (!m.ans.has(id)) m.ans.set(id, this.autoAnswer(id));
    this.h2hNextDuel(now);
  }
  curDuel() {
    return this.h2h.ms[this.h2h.order[this.h2h.cursor]];
  }
  h2hNextDuel(now) {
    const H = this.h2h;
    H.cursor++;
    if (H.cursor >= H.order.length) return this.goScores(now);
    this.setPhase("vote", this.dur("vote"), now, { duel: H.cursor });
  }
  duelVoters(m, now) {
    const ids = this.activeIds().filter((id) => id !== m.a && id !== m.b && this.presence.present(id, now));
    return ids.concat(this.audience(now));
  }
  canVoteDuel(id, m, now) {
    if (id === m.a || id === m.b) return false;
    return this.isActive(id) || this.isAudience(id, now);
  }
  vote(id, side, now) {
    if (this.phase?.kind !== "vote" || (side !== "a" && side !== "b")) return false;
    const m = this.curDuel();
    if (!this.canVoteDuel(id, m, now) || m.votes.has(id)) return false;
    m.votes.set(id, side);
    this.version++;
    this.checkEarly(now);
    return true;
  }
  h2hReveal(now) {
    const m = this.curDuel();
    let va = 0;
    let vb = 0;
    for (const s of m.votes.values()) s === "a" ? va++ : vb++;
    const tot = va + vb;
    let pa;
    let pb;
    if (!tot) pa = pb = PTS.duelPot / 2;
    else {
      pa = round10((PTS.duelPot * va) / tot);
      pb = round10((PTS.duelPot * vb) / tot);
    }
    let winner = null;
    let sweep = null;
    if (va > vb) {
      winner = "a";
      pa += PTS.duelWin;
      if (!vb && va >= 2) {
        sweep = "a";
        pa += PTS.duelSweep;
      }
    } else if (vb > va) {
      winner = "b";
      pb += PTS.duelWin;
      if (!va && vb >= 2) {
        sweep = "b";
        pb += PTS.duelSweep;
      }
    }
    m.result = { va, vb, pa, pb, winner, sweep };
    this.award(m.a, pa, m.ans.get(m.a), { votes: va, sweep: sweep === "a", bomb: tot >= 2 && !va });
    this.award(m.b, pb, m.ans.get(m.b), { votes: vb, sweep: sweep === "b", bomb: tot >= 2 && !vb });
    const extra = sweep ? this.dur("sweepExtra") : 0;
    this.setPhase("reveal", this.dur("reveal") + extra, now, { duel: this.h2h.cursor });
  }

  // ---- Act II: The Hot Seat ----
  hotBegin(now) {
    const ids = this.activeIds();
    let judges = ids.slice();
    if (judges.length > HOT_MAX) {
      // Big groups: the top of the leaderboard takes the hot seat, which gives
      // everyone else a few more chances to catch up.
      const top = ids
        .slice()
        .sort((x, y) => this.scores.get(y) - this.scores.get(x))
        .slice(0, HOT_MAX);
      judges = ids.filter((id) => top.includes(id));
    }
    this.hot = { turns: judges.map((judge) => ({ judge, skipped: false })), cursor: -1 };
    this.hotNextTurn(now);
  }
  curTurn() {
    return this.hot.turns[this.hot.cursor];
  }
  hotNextTurn(now) {
    const H = this.hot;
    while (++H.cursor < H.turns.length) {
      const t = H.turns[H.cursor];
      const answerers = this.activeIds().filter((id) => id !== t.judge);
      if (!this.present(t.judge, now) || answerers.length < 2) {
        t.skipped = true;
        continue;
      }
      Object.assign(t, {
        prompt: this.drawPrompt("hot", { judge: t.judge }),
        answerers,
        ans: new Map(),
        list: null,
        crowd: new Map(),
        pick: null,
        pickAt: null,
        guess: null,
        asleep: false,
        result: null,
      });
      return this.setPhase("hot-write", this.dur("hotWrite"), now, { turn: H.cursor });
    }
    this.goScores(now);
  }
  hotWaiting(now) {
    const t = this.curTurn();
    return t.answerers.filter((id) => this.present(id, now) && !t.ans.has(id));
  }
  hotCloseWrite(now) {
    const t = this.curTurn();
    t.answerers = t.answerers.filter((id) => this.isActive(id) || t.ans.has(id));
    for (const id of t.answerers) if (!t.ans.has(id)) t.ans.set(id, this.autoAnswer(id));
    t.list = shuffle(t.answerers.slice(), this.rng); // index in list = answer id
    this.setPhase("hot-pick", this.dur("hotPick"), now, { turn: this.hot.cursor });
  }
  hotCrowdVoters(now) {
    const t = this.curTurn();
    return this.activeIds()
      .filter((id) => id !== t.judge && this.present(id, now))
      .concat(this.audience(now));
  }
  validAid(aid, list) {
    return Number.isInteger(aid) && aid >= 0 && aid < list.length;
  }
  hotPick(id, aid, now) {
    if (this.phase?.kind !== "hot-pick") return false;
    const t = this.curTurn();
    if (id !== t.judge || t.pick != null || !this.validAid(aid, t.list)) return false;
    t.pick = aid;
    t.pickAt = now;
    this.version++;
    this.checkEarly(now);
    return true;
  }
  hotCrowd(id, aid, now) {
    if (this.phase?.kind !== "hot-pick") return false;
    const t = this.curTurn();
    if (id === t.judge || t.crowd.has(id) || !this.validAid(aid, t.list) || t.list[aid] === id) return false;
    if (!this.isActive(id) && !this.isAudience(id, now)) return false;
    t.crowd.set(id, aid);
    this.version++;
    this.checkEarly(now);
    return true;
  }
  hotClosePick(now) {
    const t = this.curTurn();
    if (t.pick == null) {
      // The judge never picked: the crowd's favourite wins, or a random one.
      t.asleep = true;
      const counts = t.list.map(() => 0);
      for (const aid of t.crowd.values()) counts[aid]++;
      const max = Math.max(0, ...counts);
      const top = counts.map((c, i) => (max > 0 && c === max ? i : -1)).filter((i) => i >= 0);
      t.pick = top.length ? pickOne(top, this.rng) : Math.floor(this.rng() * t.list.length);
      return this.hotReveal(now);
    }
    this.setPhase("hot-guess", this.dur("hotGuess"), now, { turn: this.hot.cursor });
  }
  hotGuess(id, guessId, now) {
    if (this.phase?.kind !== "hot-guess") return false;
    const t = this.curTurn();
    if (id !== t.judge || t.guess != null || !t.list.includes(guessId)) return false;
    t.guess = guessId;
    this.hotReveal(now);
    return true;
  }
  hotReveal(now) {
    const t = this.curTurn();
    const winner = t.list[t.pick];
    const counts = t.list.map(() => 0);
    for (const aid of t.crowd.values()) counts[aid]++;
    const tot = counts.reduce((a, b) => a + b, 0);
    const pts = t.list.map((_, aid) => (aid === t.pick ? PTS.judgePick : 0) + (tot ? round10((PTS.crowdPot * counts[aid]) / tot) : 0));
    t.list.forEach((id, aid) => this.award(id, pts[aid], t.ans.get(id), { votes: counts[aid], judgeWin: aid === t.pick && !t.asleep }));
    let guessRight = null;
    if (t.guess != null) {
      guessRight = t.guess === winner;
      if (guessRight && this.scores.has(t.judge)) {
        this.scores.set(t.judge, this.scores.get(t.judge) + PTS.guess);
        this.stats.get(t.judge).mindReads++;
      }
    }
    t.result = { winner, pts, counts, guessRight };
    this.setPhase("hot-reveal", this.dur("hotReveal"), now, { turn: this.hot.cursor });
  }

  // ---- Act III: The Closer ----
  closerBegin(now) {
    this.closer = { prompt: this.drawPrompt("closer"), writers: this.activeIds(), ans: new Map(), list: null, votes: new Map(), result: null };
    this.setPhase("closer-write", this.dur("closerWrite"), now);
  }
  closerWaiting(now) {
    const C = this.closer;
    return C.writers.filter((id) => this.present(id, now) && !C.ans.has(id));
  }
  closerCloseWrite(now) {
    const C = this.closer;
    C.writers = C.writers.filter((id) => this.isActive(id) || C.ans.has(id));
    for (const id of C.writers) if (!C.ans.has(id)) C.ans.set(id, this.autoAnswer(id));
    C.list = shuffle(C.writers.slice(), this.rng);
    this.setPhase("closer-vote", this.dur("closerVote"), now);
  }
  closerVoters(now) {
    return this.activeIds()
      .filter((id) => this.present(id, now))
      .concat(this.audience(now));
  }
  // Someone whose own answer is the only one on the board has nothing to vote for.
  closerCanVote(id) {
    const C = this.closer;
    return C.list.some((pid) => pid !== id);
  }
  closerVote(id, mic, tomato, now) {
    if (this.phase?.kind !== "closer-vote") return false;
    const C = this.closer;
    if (C.votes.has(id)) return false;
    if (!this.isActive(id) && !this.isAudience(id, now)) return false;
    if (!this.validAid(mic, C.list) || C.list[mic] === id) return false;
    if (tomato != null && (!this.validAid(tomato, C.list) || C.list[tomato] === id || tomato === mic)) return false;
    C.votes.set(id, { mic, tomato: tomato ?? null });
    this.version++;
    this.checkEarly(now);
    return true;
  }
  closerReveal(now) {
    const C = this.closer;
    const n = C.list.length;
    const mics = new Array(n).fill(0);
    const toms = new Array(n).fill(0);
    const micBy = Array.from({ length: n }, () => []);
    const tomBy = Array.from({ length: n }, () => []);
    for (const [voter, v] of C.votes) {
      mics[v.mic]++;
      micBy[v.mic].push(voter);
      if (v.tomato != null) {
        toms[v.tomato]++;
        tomBy[v.tomato].push(voter);
      }
    }
    const tot = mics.reduce((a, b) => a + b, 0);
    const max = Math.max(0, ...mics);
    const pts = mics.map((c) => (tot ? round10((PTS.closerPot * c) / tot) : 0) + (max > 0 && c === max ? PTS.closerTop : 0));
    C.list.forEach((id, aid) => {
      this.award(id, pts[aid], C.ans.get(id), { votes: mics[aid], bomb: tot >= 3 && !mics[aid] });
      const s = this.stats.get(id);
      if (s) s.tomatoes += toms[aid];
    });
    // Fewest mics first, so the room counts up to the winner. Ties: more tomatoes first.
    const order = shuffle(C.list.map((_, aid) => aid), this.rng).sort((x, y) => mics[x] - mics[y] || toms[y] - toms[x]);
    C.result = { mics, toms, micBy, tomBy, pts, order, max };
    const step = this.dur("closerRevealStep");
    this.setPhase("closer-reveal", this.dur("closerRevealBase") + n * step, now, { step });
  }

  // ---- results ----
  ranking() {
    const rows = this.players.map((p) => ({ id: p.id, score: this.scores.get(p.id), left: p.left }));
    rows.sort((a, b) => b.score - a.score);
    let rank = 0;
    let prev = null;
    rows.forEach((r, i) => {
      if (r.score !== prev) {
        rank = i + 1;
        prev = r.score;
      }
      r.rank = rank;
    });
    return rows;
  }

  awards() {
    const out = [];
    const count = new Map();
    for (const a of AWARDS) {
      let best = null;
      let bestV = 0;
      for (const p of this.players) {
        const v = this.stats.get(p.id)[a.stat];
        // ties go to whoever has fewer points, as a consolation
        if (v > bestV || (v === bestV && v > 0 && best && this.scores.get(p.id) < this.scores.get(best))) {
          best = p.id;
          bestV = v;
        }
      }
      if (!best || bestV < a.min || (count.get(best) || 0) >= 2) continue;
      out.push({ id: a.id, title: a.title, desc: a.desc(bestV), pid: best });
      count.set(best, (count.get(best) || 0) + 1);
      if (out.length >= 5) break;
    }
    return out;
  }

  // ---- what one client may see ----
  // pid: a player or audience id, or null for a big screen.
  view(pid, now) {
    const ph = this.phase;
    const isPlayer = pid != null && this.isActive(pid);
    const v = {
      kind: ph.kind,
      act: ph.act,
      actNo: this.actIdx + 1,
      actCount: this.acts.length,
      acts: this.acts,
      mode: this.mode,
      endsAt: ph.endsAt,
      dur: ph.dur,
    };
    const me = {};
    if (isPlayer && WRITE_KINDS.has(ph.kind) && this.mode !== "write") {
      me.hand = this.hand(pid).map((c) => ({ id: c, text: CARDS[c] }));
      me.redraws = this.redraws.get(pid) || 0;
    }
    switch (ph.kind) {
      case "intro":
        v.info = infoFor(ph.act, this.mode);
        break;

      case "write": {
        v.prog = this.activeIds().map((id) => {
          const mine = this.h2hMine(id);
          return { id, done: mine.filter((m) => m.ans.has(id)).length, of: mine.length };
        });
        if (isPlayer) {
          const mine = this.h2hMine(pid);
          me.todo = mine.filter((m) => !m.ans.has(pid)).map((m) => ({ slot: m.id, prompt: m.prompt }));
          me.of = mine.length;
          me.mine = mine.filter((m) => m.ans.has(pid)).map((m) => ({ prompt: m.prompt, text: m.ans.get(pid).text }));
        }
        break;
      }

      case "vote": {
        const m = this.curDuel();
        v.duelNo = this.h2h.cursor + 1;
        v.duelCount = this.h2h.order.length;
        v.prompt = m.prompt;
        v.answers = [m.ans.get(m.a).text, m.ans.get(m.b).text];
        v.voted = [...m.votes.keys()];
        v.voters = this.duelVoters(m, now).length;
        v.minEnd = ph.startedAt + this.dur("voteMin");
        if (pid != null) {
          me.side = pid === m.a ? "a" : pid === m.b ? "b" : null;
          me.canVote = this.canVoteDuel(pid, m, now);
          me.vote = m.votes.get(pid) ?? null;
        }
        break;
      }

      case "reveal": {
        const m = this.h2h.ms[this.h2h.order[ph.duel]];
        const r = m.result;
        v.duelNo = ph.duel + 1;
        v.duelCount = this.h2h.order.length;
        v.prompt = m.prompt;
        v.tie = !r.winner;
        v.sides = ["a", "b"].map((s) => {
          const id = m[s];
          const ans = m.ans.get(id);
          return {
            pid: id,
            text: ans.text,
            card: ans.card != null,
            auto: !!ans.auto,
            votes: [...m.votes].filter(([, x]) => x === s).map(([vid]) => vid),
            pts: s === "a" ? r.pa : r.pb,
            win: r.winner === s,
            sweep: r.sweep === s,
          };
        });
        if (pid != null) me.side = pid === m.a ? "a" : pid === m.b ? "b" : null;
        break;
      }

      case "scores": {
        const prev = new Map(this.ranking().map((r) => [r.id, r.rank]));
        v.ranking = this.ranking().map((r) => ({ ...r, prev: this.prevScores.get(r.id) ?? 0, rank: prev.get(r.id) }));
        v.next = ph.next;
        v.nextInfo = ACT_INFO[ph.next];
        break;
      }

      case "hot-write": {
        const t = this.curTurn();
        v.turn = ph.turn + 1;
        v.turns = this.hot.turns.length;
        v.judge = t.judge;
        v.prompt = t.prompt;
        v.prog = t.answerers.map((id) => ({ id, done: t.ans.has(id) ? 1 : 0, of: 1 }));
        if (pid != null) {
          me.isJudge = pid === t.judge;
          me.todo = isPlayer && t.answerers.includes(pid) && !t.ans.has(pid) ? [{ slot: `h${ph.turn}`, prompt: t.prompt }] : [];
          if (t.ans.has(pid)) me.mine = [{ prompt: t.prompt, text: t.ans.get(pid).text }];
        }
        break;
      }

      case "hot-pick": {
        const t = this.curTurn();
        v.turn = ph.turn + 1;
        v.turns = this.hot.turns.length;
        v.judge = t.judge;
        v.prompt = t.prompt;
        v.list = t.list.map((id, aid) => ({ aid, text: t.ans.get(id).text }));
        v.crowdVoted = [...t.crowd.keys()];
        v.picked = t.pick != null;
        if (pid != null) {
          me.isJudge = pid === t.judge;
          me.myAid = t.list.indexOf(pid);
          me.crowd = t.crowd.get(pid) ?? null;
          me.pick = me.isJudge ? t.pick : null;
          me.canCrowd = !me.isJudge && (isPlayer || this.isAudience(pid, now));
        }
        break;
      }

      case "hot-guess": {
        const t = this.curTurn();
        v.turn = ph.turn + 1;
        v.turns = this.hot.turns.length;
        v.judge = t.judge;
        v.prompt = t.prompt;
        v.chosen = { aid: t.pick, text: t.ans.get(t.list[t.pick]).text };
        // seat order, never answer order: that would give the author away
        v.candidates = this.players.map((p) => p.id).filter((id) => t.list.includes(id));
        if (pid != null) {
          me.isJudge = pid === t.judge;
          me.mineChosen = t.list[t.pick] === pid;
        }
        break;
      }

      case "hot-reveal": {
        const t = this.curTurn();
        const r = t.result;
        v.turn = ph.turn + 1;
        v.turns = this.hot.turns.length;
        v.judge = t.judge;
        v.prompt = t.prompt;
        v.pick = t.pick;
        v.winner = r.winner;
        v.asleep = t.asleep;
        v.guess = t.guess;
        v.guessRight = r.guessRight;
        v.guessPts = r.guessRight ? PTS.guess : 0;
        v.list = t.list.map((id, aid) => {
          const ans = t.ans.get(id);
          return {
            aid,
            pid: id,
            text: ans.text,
            card: ans.card != null,
            auto: !!ans.auto,
            crowd: [...t.crowd].filter(([, a]) => a === aid).map(([vid]) => vid),
            pts: r.pts[aid],
          };
        });
        break;
      }

      case "closer-write": {
        const C = this.closer;
        v.prompt = C.prompt;
        v.prog = C.writers.map((id) => ({ id, done: C.ans.has(id) ? 1 : 0, of: 1 }));
        if (pid != null) {
          me.todo = isPlayer && C.writers.includes(pid) && !C.ans.has(pid) ? [{ slot: "c", prompt: C.prompt }] : [];
          if (C.ans.has(pid)) me.mine = [{ prompt: C.prompt, text: C.ans.get(pid).text }];
        }
        break;
      }

      case "closer-vote": {
        const C = this.closer;
        v.prompt = C.prompt;
        v.list = C.list.map((id, aid) => ({ aid, text: C.ans.get(id).text }));
        v.voted = [...C.votes.keys()];
        v.voters = this.closerVoters(now).length;
        if (pid != null) {
          me.myAid = C.list.indexOf(pid);
          me.vote = C.votes.get(pid) ?? null;
          me.canVote = (isPlayer || this.isAudience(pid, now)) && this.closerCanVote(pid);
        }
        break;
      }

      case "closer-reveal": {
        const C = this.closer;
        const r = C.result;
        v.prompt = C.prompt;
        v.step = ph.step;
        v.order = r.order.map((aid) => {
          const id = C.list[aid];
          const ans = C.ans.get(id);
          return {
            aid,
            pid: id,
            text: ans.text,
            card: ans.card != null,
            auto: !!ans.auto,
            mics: r.micBy[aid],
            tomatoes: r.tomBy[aid],
            pts: r.pts[aid],
            top: r.max > 0 && r.mics[aid] === r.max,
          };
        });
        break;
      }

      case "final":
        v.ranking = this.final.ranking;
        v.awards = this.final.awards;
        break;
    }
    v.me = me;
    return v;
  }
}
