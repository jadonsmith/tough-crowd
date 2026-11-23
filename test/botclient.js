// A scripted phone: joins a room over a real WebSocket and plays whatever is
// on screen. Used by the headless sim (test/sim.js) and test/bots.js.

import { WebSocket } from "ws";

const LINES = ["My lawyer says no comment", "Honestly? Soup.", "That's between me and the moon", "A strongly worded haiku", "Three bees and a dream", "Seventeen pigeons, one plan"];

export class BotClient {
  constructor({ url, name, code = null, create = false, emoji = null, speed = 1, log = () => {} }) {
    this.url = url;
    this.name = name;
    this.code = code;
    this.create = create;
    this.emoji = emoji;
    this.speed = speed; // multiplies think time
    this.log = log;
    this.v = null;
    this.token = null;
    this.acted = new Set();
    this.states = 0;
    this.errors = [];
    this.finals = 0;
    this.joined = null;
    this.closedByUs = false;
  }

  open(resume = false) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on("open", () => {
        if (resume) ws.send(JSON.stringify({ t: "resume", code: this.code, token: this.token }));
        else if (this.create) ws.send(JSON.stringify({ t: "create", name: this.name, emoji: this.emoji }));
        else ws.send(JSON.stringify({ t: "join", code: this.code, name: this.name, emoji: this.emoji }));
      });
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        if (m.t === "joined") {
          this.code = m.code;
          this.you = m.you;
          if (m.token) this.token = m.token;
          this.joined = m;
          resolve(this);
        } else if (m.t === "state") {
          this.states++;
          this.v = m;
          this.onState(m);
        } else if (m.t === "error") {
          this.errors.push(m);
          reject(new Error(m.msg));
        } else if (m.t === "resumeFail") {
          reject(new Error("resume failed"));
        }
      });
      ws.on("error", (e) => reject(e));
    });
  }

  send(m) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  drop() {
    this.closedByUs = true;
    this.ws.terminate();
  }

  later(key, ms, fn) {
    if (this.acted.has(key)) return;
    this.acted.add(key);
    setTimeout(fn, ms * this.speed);
  }

  onState(v) {
    const g = v.game;
    if (!g) return;
    const me = g.me || {};
    const k = `${g.kind}:${g.duelNo || g.turn || 0}:${g.actNo}`;
    switch (g.kind) {
      case "write":
      case "hot-write":
      case "closer-write":
        for (const t of me.todo || []) {
          this.later(`${k}:${t.slot}`, 150 + Math.random() * 600, () => {
            const useCard = me.hand && me.hand.length && (g.mode === "cards" || Math.random() < 0.6);
            const pick = useCard ? { card: me.hand[Math.floor(Math.random() * me.hand.length)].id } : { text: LINES[Math.floor(Math.random() * LINES.length)] + " " + Math.floor(Math.random() * 99) };
            this.send({ t: "answer", slot: t.slot, ...pick });
          });
          break; // one at a time; the next state brings the next prompt
        }
        break;
      case "vote":
        if (me.canVote && !me.vote) this.later(k, 100 + Math.random() * 400, () => this.send({ t: "vote", side: Math.random() < 0.5 ? "a" : "b" }));
        break;
      case "hot-pick":
        if (me.isJudge && me.pick == null) this.later(k, 200 + Math.random() * 500, () => this.send({ t: "judge", aid: Math.floor(Math.random() * g.list.length) }));
        else if (me.canCrowd && me.crowd == null) {
          const opts = g.list.map((a) => a.aid).filter((a) => a !== me.myAid);
          if (opts.length) this.later(k, 100 + Math.random() * 300, () => this.send({ t: "crowd", aid: opts[Math.floor(Math.random() * opts.length)] }));
        }
        break;
      case "hot-guess":
        if (me.isJudge) this.later(k, 150 + Math.random() * 300, () => this.send({ t: "guess", id: g.candidates[Math.floor(Math.random() * g.candidates.length)] }));
        break;
      case "closer-vote":
        if (me.canVote && !me.vote) {
          const opts = g.list.map((a) => a.aid).filter((a) => a !== me.myAid);
          if (opts.length) {
            const mic = opts[Math.floor(Math.random() * opts.length)];
            const rest = opts.filter((a) => a !== mic);
            const tomato = rest.length && Math.random() < 0.5 ? rest[Math.floor(Math.random() * rest.length)] : null;
            this.later(k, 150 + Math.random() * 400, () => this.send({ t: "closer", mic, tomato }));
          }
        }
        break;
      case "reveal":
      case "hot-reveal":
      case "closer-reveal":
        if (Math.random() < 0.3) this.later(k, 100, () => this.send({ t: "react", e: ["lol", "clap", "fire", "tomato", "dead"][Math.floor(Math.random() * 5)] }));
        break;
      case "final":
        if (!this.acted.has(`final:${v.games}`)) {
          this.acted.add(`final:${v.games}`);
          this.finals++;
        }
        break;
    }
  }
}
