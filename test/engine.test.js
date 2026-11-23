// Engine tests: targeted rules plus hundreds of random games on a fake clock.
// Run: node --test test/engine.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { Game, CardDeck, PromptPool, PTS, HAND, ACT_ORDER } from "../game/engine.js";
import { CARDS, PROMPTS } from "../game/content.js";
import { cleanText, cleanName } from "../game/filter.js";

// small seeded rng so failures can be replayed
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGame({ n = 4, seed = 1, settings = {}, audience = [] } = {}) {
  const rng = mulberry(seed);
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i}` }));
  const conn = new Map(players.map((p) => [p.id, { on: true, seen: 0 }]));
  const aud = new Set(audience);
  const presence = {
    present: (id, now) => {
      const c = conn.get(id);
      return !!c && (c.on || now - c.seen < 15000);
    },
    audience: () => [...aud],
    isAudience: (id) => aud.has(id),
  };
  const game = new Game({
    players,
    settings: { acts: { h2h: true, hot: true, closer: true }, answers: "mix", pace: "normal", family: false, ...settings },
    deck: new CardDeck(rng),
    prompts: new PromptPool(rng),
    presence,
    rng,
    now: 0,
  });
  return { game, players, conn, aud, rng };
}

// Skip a timed phase.
function skip(game, now) {
  const t = game.phase.endsAt;
  assert.ok(t != null, `phase ${game.phase.kind} has no timer`);
  game.tick(t);
  return t;
}

test("content looks sane", () => {
  assert.ok(PROMPTS.h2h.length >= 150, "h2h prompts");
  assert.ok(PROMPTS.hot.length >= 50, "hot prompts");
  assert.ok(PROMPTS.closer.length >= 35, "closer prompts");
  assert.ok(CARDS.length >= 300, `cards: ${CARDS.length}`);
  for (const p of PROMPTS.hot) assert.ok(p.includes("{judge}"), `hot prompt without judge: ${p}`);
  for (const p of PROMPTS.closer) assert.ok(!p.includes("{"), `closer prompt with placeholder: ${p}`);
  for (const p of PROMPTS.h2h) assert.ok(!p.includes("{judge}"), p);
  const all = [...PROMPTS.h2h, ...PROMPTS.hot, ...PROMPTS.closer, ...CARDS];
  const seen = new Set();
  for (const s of all) {
    const k = s.toLowerCase();
    assert.ok(!seen.has(k), `duplicate: ${s}`);
    seen.add(k);
    assert.ok(s.length <= 80, `too long: ${s}`);
  }
  for (const c of CARDS) assert.ok(c.length <= 70, `card too long for the 70-char answer box: ${c}`);
});

test("filter", () => {
  assert.equal(cleanText("  hello\u202e   world \u200b "), "hello world");
  assert.equal(cleanText("x".repeat(200)).length, 70);
  assert.equal(cleanText("what the fuck", { family: true }), "what the f✱✱✱");
  assert.equal(cleanText("what the fuck"), "what the fuck");
  assert.equal(cleanText("a raccoon class assessment", { family: true }), "a raccoon class assessment");
  assert.ok(!cleanText("you retard").includes("retard"));
  assert.equal(cleanName("  {judge}<b>  "), "judgeb");
  assert.equal([...cleanName("😎😎😎😎😎😎😎😎😎😎😎😎😎😎")].length, 12);
});

test("head to head: everyone gets two prompts against two different rivals", () => {
  for (let n = 3; n <= 10; n++) {
    const { game } = makeGame({ n, seed: n });
    let now = skip(game, 0); // intro
    assert.equal(game.phase.kind, "write");
    const ms = game.h2h.ms;
    assert.equal(ms.length, n);
    for (let i = 0; i < n; i++) {
      const id = `p${i}`;
      const mine = ms.filter((m) => m.a === id || m.b === id);
      assert.equal(mine.length, 2);
      const rivals = mine.map((m) => (m.a === id ? m.b : m.a));
      assert.notEqual(rivals[0], rivals[1]);
    }
    // {player} is never one of the two answering
    for (const m of ms) {
      for (const id of [m.a, m.b]) assert.ok(!m.prompt.includes(game.name(id)) || PROMPTS.h2h.includes(m.prompt), m.prompt);
    }
  }
});

test("duel scoring: split, win bonus, sweep", () => {
  const { game } = makeGame({ n: 5, seed: 3 });
  let now = skip(game, 0);
  // everyone plays their first card on both prompts
  for (const p of game.players) for (const t of game.view(p.id, now).me.todo) assert.ok(game.answer(p.id, t.slot, { card: game.hand(p.id)[0] }, now));
  assert.equal(game.phase.kind, "vote", "write ends early once all answered");
  const m = game.curDuel();
  const voters = game.players.map((p) => p.id).filter((id) => id !== m.a && id !== m.b);
  assert.equal(voters.length, 3);
  assert.ok(!game.vote(m.a, "a", now), "authors can't vote");
  now += 6000;
  for (const id of voters) assert.ok(game.vote(id, "a", now));
  assert.equal(game.phase.kind, "reveal", "vote ends early once all voted");
  assert.deepEqual(
    { pa: m.result.pa, pb: m.result.pb, sweep: m.result.sweep },
    { pa: PTS.duelPot + PTS.duelWin + PTS.duelSweep, pb: 0, sweep: "a" },
  );
  assert.equal(game.scores.get(m.a), 900);
  // next duel: 2-1 split
  now = skip(game, now);
  const m2 = game.curDuel();
  const v2 = game.players.map((p) => p.id).filter((id) => id !== m2.a && id !== m2.b);
  now += 6000;
  game.vote(v2[0], "a", now);
  game.vote(v2[1], "a", now);
  game.vote(v2[2], "b", now);
  assert.equal(m2.result.pa, 400 + PTS.duelWin);
  assert.equal(m2.result.pb, 200);
  assert.equal(m2.result.sweep, null);
});

test("votes don't end the duel before the minimum read time", () => {
  const { game } = makeGame({ n: 3, seed: 4 });
  let now = skip(game, 0);
  for (const p of game.players) for (const t of game.view(p.id, now).me.todo) game.answer(p.id, t.slot, { text: "hi " + p.id + t.slot }, now);
  assert.equal(game.phase.kind, "vote");
  const m = game.curDuel();
  const voter = game.players.map((p) => p.id).find((id) => id !== m.a && id !== m.b);
  game.vote(voter, "b", now + 100);
  assert.equal(game.phase.kind, "vote");
  game.tick(now + 6000);
  assert.equal(game.phase.kind, "reveal");
  assert.equal(m.result.pb, PTS.duelPot + PTS.duelWin, "one voter: no sweep bonus");
});

test("timeouts play a card for anyone who didn't answer", () => {
  const { game } = makeGame({ n: 4, seed: 5 });
  let now = skip(game, 0);
  now = skip(game, now); // write timer runs out with nobody answering
  assert.equal(game.phase.kind, "vote");
  for (const m of game.h2h.ms) {
    assert.ok(m.ans.get(m.a).auto && m.ans.get(m.b).auto);
    assert.ok(CARDS.includes(m.ans.get(m.a).text));
  }
  for (const p of game.players) assert.equal(game.hand(p.id).length, HAND, "hands refill");
});

test("cards-only and write-only modes", () => {
  const c = makeGame({ n: 3, seed: 6, settings: { answers: "cards" } });
  let now = skip(c.game, 0);
  const t = c.game.view("p0", now).me.todo[0];
  assert.ok(!c.game.answer("p0", t.slot, { text: "typed" }, now));
  assert.ok(c.game.answer("p0", t.slot, { card: c.game.hand("p0")[0] }, now));

  const w = makeGame({ n: 3, seed: 7, settings: { answers: "write" } });
  now = skip(w.game, 0);
  const t2 = w.game.view("p0", now).me.todo[0];
  assert.equal(w.game.view("p0", now).me.hand, undefined, "no hand shown in write-only");
  assert.ok(!w.game.answer("p0", t2.slot, { card: w.game.hand("p0")[0] }, now));
  assert.ok(w.game.answer("p0", t2.slot, { text: "typed" }, now));
});

test("a card can't be played twice or from someone else's hand", () => {
  const { game } = makeGame({ n: 3, seed: 8 });
  const now = skip(game, 0);
  const [s1, s2] = game.view("p0", now).me.todo.map((t) => t.slot);
  const card = game.hand("p0")[0];
  const other = game.hand("p1")[0];
  assert.ok(!game.answer("p0", s1, { card: other }, now));
  assert.ok(game.answer("p0", s1, { card }, now));
  assert.ok(!game.answer("p0", s2, { card }, now));
  assert.ok(!game.answer("p0", s1, { text: "again" }, now), "can't answer the same slot twice");
});

test("redraw: once per act, fresh cards", () => {
  const { game } = makeGame({ n: 3, seed: 9 });
  const now = skip(game, 0);
  const before = game.hand("p0").slice();
  assert.ok(game.redraw("p0", now));
  const after = game.hand("p0");
  assert.equal(after.length, HAND);
  assert.ok(after.every((c) => !before.includes(c)));
  assert.ok(!game.redraw("p0", now));
});

test("hot seat: judge pick, crowd votes, guessing", () => {
  const { game } = makeGame({ n: 4, seed: 10, settings: { acts: { h2h: false, hot: true, closer: false } } });
  let now = skip(game, 0);
  assert.equal(game.phase.kind, "hot-write");
  const t = game.curTurn();
  assert.ok(t.prompt.includes(game.name(t.judge)));
  assert.equal(game.view(t.judge, now).me.todo.length, 0, "judge doesn't answer");
  for (const id of t.answerers) game.answer(id, `h${game.hot.cursor}`, { text: `answer from ${id}` }, now);
  assert.equal(game.phase.kind, "hot-pick");
  // the guess list must not be in answer order
  const winnerAid = 1;
  const crowdIds = t.answerers;
  // each crowd member votes for the winner unless it's their own
  for (const id of crowdIds) {
    const target = t.list[winnerAid] === id ? 0 : winnerAid;
    assert.ok(!game.hotCrowd(id, t.list.indexOf(id), now), "no voting for yourself");
    assert.ok(game.hotCrowd(id, target, now));
  }
  assert.ok(game.hotPick(t.judge, winnerAid, now));
  assert.equal(game.phase.kind, "hot-guess", "pick + whole crowd voted ends the phase");
  const author = t.list[winnerAid];
  const v = game.view(null, now);
  assert.equal(v.chosen.aid, winnerAid);
  assert.deepEqual(v.candidates, game.players.map((p) => p.id).filter((id) => t.list.includes(id)));
  assert.ok(game.hotGuess(t.judge, author, now));
  assert.equal(game.phase.kind, "hot-reveal");
  assert.equal(t.result.guessRight, true);
  assert.equal(game.scores.get(t.judge), PTS.guess);
  // winner: 400 + crowd share (2 of 3 crowd votes went to them, the third to aid 0)
  assert.equal(game.scores.get(author), PTS.judgePick + Math.round((PTS.crowdPot * 2) / 3 / 10) * 10);
});

test("hot seat: a judge who falls asleep lets the crowd decide", () => {
  const { game } = makeGame({ n: 3, seed: 11, settings: { acts: { h2h: false, hot: true, closer: false } } });
  let now = skip(game, 0);
  now = skip(game, now); // nobody writes
  const t = game.curTurn();
  const [x, y] = t.answerers;
  game.hotCrowd(x, t.list.indexOf(y), now);
  now = skip(game, now); // judge never picks
  assert.equal(game.phase.kind, "hot-reveal");
  assert.ok(t.asleep);
  assert.equal(t.list[t.pick], y);
});

test("hot seat with lots of players: six turns, the leaders judge", () => {
  const { game } = makeGame({ n: 9, seed: 12, settings: { acts: { h2h: true, hot: true, closer: false } } });
  for (let i = 0; i < 9; i++) game.scores.set(`p${i}`, i * 100);
  let now = skip(game, 0);
  // skip all of h2h
  while (game.act === "h2h") now = skip(game, now);
  assert.equal(game.phase.kind, "intro");
  // the scores changed during h2h; recompute expected judges from the scores now
  const top = [...game.scores].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id);
  now = skip(game, now);
  assert.equal(game.hot.turns.length, 6);
  assert.deepEqual(new Set(game.hot.turns.map((t) => t.judge)), new Set(top));
});

test("closer: mics, tomatoes, top bonus, reveal order", () => {
  const { game } = makeGame({ n: 4, seed: 13, settings: { acts: { h2h: false, hot: false, closer: true } } });
  let now = skip(game, 0);
  assert.equal(game.phase.kind, "closer-write");
  for (const p of game.players) game.answer(p.id, "c", { text: `closer ${p.id}` }, now);
  assert.equal(game.phase.kind, "closer-vote");
  const C = game.closer;
  const aidOf = (id) => C.list.indexOf(id);
  now += 7000;
  assert.ok(!game.closerVote("p0", aidOf("p0"), null, now), "no mic for yourself");
  assert.ok(!game.closerVote("p0", aidOf("p1"), aidOf("p1"), now), "mic and tomato can't be the same answer");
  assert.ok(game.closerVote("p0", aidOf("p1"), aidOf("p2"), now));
  assert.ok(game.closerVote("p2", aidOf("p1"), null, now));
  assert.ok(game.closerVote("p3", aidOf("p1"), aidOf("p2"), now));
  assert.ok(game.closerVote("p1", aidOf("p0"), null, now));
  assert.equal(game.phase.kind, "closer-reveal");
  assert.equal(game.scores.get("p1"), Math.round((PTS.closerPot * 3) / 4 / 10) * 10 + PTS.closerTop);
  assert.equal(game.stats.get("p2").tomatoes, 2);
  const order = game.view(null, now).order;
  assert.equal(order[order.length - 1].pid, "p1", "winner revealed last");
  assert.ok(order[order.length - 1].top);
  now = skip(game, now);
  assert.equal(game.phase.kind, "final");
  assert.equal(game.view(null, now).ranking[0].id, "p1");
});

test("audience can vote in duels but not write", () => {
  const { game } = makeGame({ n: 3, seed: 14, audience: ["aud1"] });
  let now = skip(game, 0);
  assert.equal(game.view("aud1", now).me.todo, undefined);
  for (const p of game.players) for (const t of game.view(p.id, now).me.todo) game.answer(p.id, t.slot, { card: game.hand(p.id)[0] }, now);
  assert.equal(game.phase.kind, "vote");
  assert.ok(game.view("aud1", now).me.canVote);
  assert.ok(game.vote("aud1", "b", now + 1000));
});

test("a player leaving mid-game doesn't stall anything", () => {
  const { game, conn } = makeGame({ n: 4, seed: 15 });
  let now = skip(game, 0);
  game.markLeft("p2", now);
  conn.get("p2").on = false;
  for (const p of game.players) if (p.id !== "p2") for (const t of game.view(p.id, now).me.todo) game.answer(p.id, t.slot, { card: game.hand(p.id)[0] }, now);
  assert.equal(game.phase.kind, "vote", "doesn't wait for the player who left");
});

test("a disconnected player is waited on briefly, then skipped", () => {
  const { game, conn } = makeGame({ n: 3, seed: 16 });
  let now = skip(game, 0);
  conn.get("p1").on = false;
  conn.get("p1").seen = now;
  for (const id of ["p0", "p2"]) for (const t of game.view(id, now).me.todo) game.answer(id, t.slot, { card: game.hand(id)[0] }, now);
  assert.equal(game.phase.kind, "write");
  game.tick(now + 16000);
  assert.equal(game.phase.kind, "vote");
});

test("views never reveal who wrote what before the reveal", () => {
  const { game } = makeGame({ n: 5, seed: 17 });
  let now = 0;
  let guard = 0;
  while (game.phase.kind !== "final" && guard++ < 500) {
    const ph = game.phase.kind;
    const views = [null, ...game.players.map((p) => p.id)].map((id) => game.view(id, now));
    if (ph === "vote") for (const v of views) assert.ok(v.answers.every((a) => typeof a === "string"));
    if (ph === "hot-pick" || ph === "closer-vote") {
      for (const v of views) for (const a of v.list) assert.deepEqual(Object.keys(a).sort(), ["aid", "text"]);
    }
    if (ph === "hot-guess") for (const v of views) assert.equal(v.chosen.pid, undefined);
    now = skip(game, now);
  }
  assert.equal(game.phase.kind, "final");
});

test("random games always finish, with sane scores", () => {
  const MODES = ["mix", "cards", "write"];
  const ACTSETS = [
    { h2h: true, hot: true, closer: true },
    { h2h: true, hot: false, closer: true },
    { h2h: false, hot: true, closer: false },
    { h2h: true, hot: false, closer: false },
    { h2h: false, hot: false, closer: true },
  ];
  let games = 0;
  for (let seed = 100; seed < 460; seed++) {
    const r = mulberry(seed);
    const n = 3 + Math.floor(r() * 8);
    const settings = { answers: MODES[seed % 3], acts: ACTSETS[seed % ACTSETS.length], pace: ["relaxed", "normal", "quick"][seed % 3], family: !!(seed % 2) };
    const { game, conn, aud } = makeGame({ n, seed, settings, audience: seed % 4 === 0 ? ["a1", "a2"] : [] });
    let now = 0;
    let steps = 0;
    while (game.phase.kind !== "final") {
      assert.ok(++steps < 4000, `seed ${seed} stuck in ${game.phase.kind}`);
      now += Math.floor(r() * 2500);
      // random churn
      if (r() < 0.01) {
        const id = `p${Math.floor(r() * n)}`;
        const c = conn.get(id);
        c.on = !c.on;
        c.seen = now;
      }
      if (r() < 0.002 && game.activeIds().length > 3) game.markLeft(game.activeIds()[Math.floor(r() * game.activeIds().length)], now);
      // random actions from random people
      const ids = [...game.players.map((p) => p.id), ...aud];
      for (const id of ids) {
        if (r() < 0.5) continue;
        const v = game.view(id, now);
        const me = v.me;
        switch (v.kind) {
          case "write":
          case "hot-write":
          case "closer-write":
            if (me.todo && me.todo.length) {
              const t = me.todo[0];
              if (me.hand && r() < 0.6) game.answer(id, t.slot, { card: me.hand[Math.floor(r() * me.hand.length)].id }, now);
              else game.answer(id, t.slot, { text: r() < 0.05 ? "   " : `typed ${Math.floor(r() * 1e6)}` }, now);
              if (me.hand && r() < 0.05) game.redraw(id, now);
            }
            break;
          case "vote":
            if (me.canVote) game.vote(id, r() < 0.5 ? "a" : "b", now);
            break;
          case "hot-pick":
            if (me.isJudge && r() < 0.7) game.hotPick(id, Math.floor(r() * v.list.length), now);
            else if (me.canCrowd) game.hotCrowd(id, Math.floor(r() * v.list.length), now);
            break;
          case "hot-guess":
            if (me.isJudge) game.hotGuess(id, v.candidates[Math.floor(r() * v.candidates.length)], now);
            break;
          case "closer-vote":
            if (me.canVote) game.closerVote(id, Math.floor(r() * v.list.length), r() < 0.5 ? Math.floor(r() * v.list.length) : null, now);
            break;
        }
      }
      game.tick(now);
      // invariants
      for (const p of game.players) {
        const s = game.scores.get(p.id);
        assert.ok(Number.isInteger(s) && s >= 0 && s % 10 === 0, `score ${s}`);
        if (!p.left) assert.ok(game.hand(p.id).length <= HAND);
      }
    }
    const fin = game.view(null, now);
    assert.equal(fin.ranking.length, n);
    assert.ok(fin.awards.length <= 5);
    for (let i = 1; i < fin.ranking.length; i++) assert.ok(fin.ranking[i - 1].score >= fin.ranking[i].score);
    game.returnCards();
    games++;
  }
  assert.equal(games, 360);
});

test("deck: no card is ever in two hands", () => {
  const { game } = makeGame({ n: 10, seed: 21 });
  let now = skip(game, 0);
  const seen = new Set();
  for (const p of game.players)
    for (const c of game.hand(p.id)) {
      assert.ok(!seen.has(c));
      seen.add(c);
    }
  assert.ok(ACT_ORDER.length === 3);
});
