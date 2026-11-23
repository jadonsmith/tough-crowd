// The big screen (?tv): the stage the whole room watches. It never plays; it
// shows the room code and QR, reads prompts aloud, runs the lounge music while
// everyone writes, and choreographs every reveal.

import { Net } from "./net.js";
import { h, fill, avatar, promptEl, cardEl, timerRing, fmt, toast, store, setClock, qrSvg, logoEl, howTo, icon, ROMAN, installWall, fitText, onTick } from "./ui.js";
import { audio } from "./audio.js";
import { voice } from "./voice.js";
import { confetti } from "./confetti.js";

const params = new URLSearchParams(location.search);
const st = store("tv" + (params.get("ns") ? ":" + params.get("ns") : ""));
const ACT_SHORT = { h2h: "Head to Head", hot: "The Hot Seat", closer: "The Closer" };
const REACT_EMOJI = { lol: "😂", clap: "👏", fire: "🔥", tomato: "🍅", dead: "💀" };
const MUSIC_KINDS = new Set(["lobby", "write", "hot-write", "closer-write", "scores"]);

const S = {
  v: null,
  key: null,
  scr: null,
  busy: false,
  resuming: false,
  unlocked: false,
  sound: st.get("sound") !== false,
  voiceOn: st.get("voice") !== false,
  musicOn: st.get("music") !== false,
  seenPlayers: new Set(),
  lastTick: -1,
};
voice.on = S.voiceOn;

let net;
let stage;
let tvMain;
let tvTop;
let fx;
let ctrl;
let unlockEl;

const P = (id) => (S.v ? S.v.players.find((p) => p.id === id) || S.v.audience.find((p) => p.id === id) : null);
const nameOf = (id) => P(id)?.name || "Someone";
const joinHost = () => `${location.host}${location.pathname.replace(/[^/]*$/, "")}`.replace(/\/$/, "");
const inviteUrl = (code) => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}?room=${code}`;
const later = (ms, fn) => {
  const key = S.key;
  setTimeout(() => S.key === key && fn(), ms);
};

function say(lines, opts) {
  if (!S.unlocked) return;
  voice.say(lines, opts);
}

// ---------- stage scaling ----------
function fit() {
  const s = Math.min(innerWidth / 1600, innerHeight / 900);
  stage.style.setProperty("--s", s.toFixed(4));
}

// ---------- pieces ----------
function seatCard(p, i) {
  return h(
    "div",
    { class: `seat${p ? "" : " open"}${p && !p.on ? " off" : ""}${p && !S.seenPlayers.has(p.id) ? " new" : ""}`, style: { "--i": i } },
    p ? avatar(p, { size: "l" }) : h("span", { class: "av av-l ghost" }),
    h("span", { class: "seat-n", text: p ? p.name : "Seat open" }),
    p && p.id === S.v.host ? h("span", { class: "seat-badge" }, icon("crown"), "host") : null,
    p && p.bot ? h("span", { class: "seat-badge", text: "bot" }) : null,
  );
}

function progGrid(prog, { label = "" } = {}) {
  return h(
    "div",
    { class: "tv-prog" },
    label ? h("p", { class: "tv-prog-l", text: label }) : null,
    h(
      "div",
      { class: "tv-prog-g" },
      (prog || []).map((x) => {
        const done = x.done >= x.of;
        return h("div", { class: `tp${done ? " done" : ""}` }, h("div", { class: "tp-av" }, avatar(P(x.id), { size: "xl" }), h("span", { class: "tp-mark", "aria-hidden": "true" }, done ? icon("vote") : icon("pen"))), h("span", { class: "tp-n", text: nameOf(x.id) }), x.of > 1 ? h("span", { class: "tp-c", text: `${x.done}/${x.of}` }) : null);
      }),
    ),
  );
}

function topBar(v) {
  const g = v && v.game;
  fill(tvTop, 
    h("div", { class: "tt-left" }, g && g.act ? h("span", { class: `act-pill big act-${g.act}` }, `Act ${ROMAN[g.actNo]}`, h("i"), ACT_SHORT[g.act]) : null),
    h("div", { class: "tt-right" }, v && v.game ? h("div", { class: "join-chip" }, h("span", { class: "jc-l", text: "Join" }), h("b", { text: joinHost() }), h("span", { class: "jc-code", text: v.code })) : null),
  );
}

function stampEl(text, cls = "") {
  return h("span", { class: `stamp ${cls}`, text });
}

function whoTag(pid, { pts = null, card = false, auto = false, cls = "" } = {}) {
  const p = P(pid);
  return h(
    "div",
    { class: `tv-who ${cls}` },
    avatar(p, { size: "m" }),
    h("span", { class: "tw-n", text: p ? p.name : "Someone" }),
    h("span", { class: "tw-src" }, card ? icon("cards") : icon("pen"), card ? (auto ? "time ran out" : "played a card") : "wrote it"),
    pts != null ? h("span", { class: `tw-pts${pts ? "" : " zero"}`, text: `+${fmt(pts)}` }) : null,
  );
}

// ---------- screens ----------
function scrHome() {
  const codeIn = h("input", { class: "in code-in big", maxlength: 4, placeholder: "CODE", autocapitalize: "characters", autocomplete: "off", spellcheck: "false", "aria-label": "Room code" });
  codeIn.oninput = () => (codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4));
  const startBtn = h("button", { class: "btn primary huge", type: "button" }, icon("tv"), "Start a room on this screen");
  const watchBtn = h("button", { class: "btn amber big", type: "button" }, "Show it");
  startBtn.onclick = () => {
    unlock();
    S.busy = true;
    net.send({ t: "createTv" });
    paint();
  };
  const watch = () => {
    unlock();
    const code = codeIn.value.trim();
    if (code.length !== 4) return toast("Room codes are four letters.");
    S.busy = true;
    net.send({ t: "watch", code });
    paint();
  };
  watchBtn.onclick = watch;
  codeIn.onkeydown = (e) => e.key === "Enter" && watch();
  const paint = () => {
    startBtn.disabled = S.busy;
    watchBtn.disabled = S.busy;
  };
  const el = h(
    "section",
    { class: "tv-scr tv-home" },
    h("div", { class: "th-hero" }, logoEl("logo-tv"), h("p", { class: "th-tag", text: "The party game where the room decides what's funny." })),
    h("div", { class: "th-actions" }, startBtn, h("div", { class: "th-watch" }, h("span", { class: "muted", text: "Already have a room?" }), codeIn, watchBtn)),
    h("div", { class: "th-how" }, howTo("how-row")),
    h("p", { class: "th-foot muted", text: "This screen is the stage. Everyone plays on their own phone." }),
  );
  return { el, update: paint };
}

function scrLobby(v) {
  const left = h(
    "div",
    { class: "tvl-left" },
    logoEl("logo-lobby"),
    h("p", { class: "tvl-grab", text: "Grab your phone and go to" }),
    h("p", { class: "tvl-url", text: joinHost() }),
    h(
      "div",
      { class: "tvl-join" },
      h("div", { class: "tvl-codebox" }, h("p", { class: "eyebrow", text: "Room code" }), h("div", { class: "code-tiles huge" }, [...v.code].map((ch, i) => h("span", { class: "tile", style: { "--i": i }, text: ch })))),
      h("div", { class: "qr-paper taped" }, qrSvg(inviteUrl(v.code)), h("span", { class: "qr-cap", text: "or scan to join" })),
    ),
  );
  const seats = h("div", { class: "seats" });
  const status = h("div", { class: "tvl-status" });
  const chips = h("div", { class: "chips" });
  const right = h("div", { class: "tvl-right" }, h("div", { class: "row-between" }, h("h2", { class: "tv-h2", text: "Tonight's line-up" }), h("span", { class: "tvl-count" })), seats, chips, status);
  const el = h("section", { class: "tv-scr tv-lobby" }, left, right);
  let count = -1;
  function update(v) {
    const ps = v.players;
    fill(seats, ...Array.from({ length: Math.max(v.max, ps.length) }, (_, i) => seatCard(ps[i], i)));
    for (const p of ps) {
      if (!S.seenPlayers.has(p.id)) {
        S.seenPlayers.add(p.id);
        if (count >= 0) audio.pop(S.seenPlayers.size % 6);
      }
    }
    count = ps.length;
    el.querySelector(".tvl-count").textContent = `${ps.length}/${v.max}${v.audience.length ? ` · ${v.audience.length} in the audience` : ""}`;
    const s = v.settings;
    fill(chips, 
      ...["h2h", "hot", "closer"].filter((a) => s.acts[a]).map((a) => h("span", { class: "chip", text: ACT_SHORT[a] })),
      h("span", { class: "chip alt", text: { mix: "Write or play a card", cards: "Cards only", write: "Write only" }[s.answers] }),
      h("span", { class: "chip alt", text: `${s.pace[0].toUpperCase()}${s.pace.slice(1)} pace` }),
      s.family ? h("span", { class: "chip alt", text: "Family filter" }) : null,
    );
    const need = v.min - ps.length;
    const host = P(v.host);
    fill(status, 
      v.last ? h("p", { class: "last-show" }, "Last show's headliner: ", h("b", { text: `${v.last.emoji} ${v.last.name}` }), ` with ${fmt(v.last.score)}`) : "",
      h(
        "p",
        { class: "tvl-wait" },
        need > 0 ? `Need ${need} more player${need === 1 ? "" : "s"} to start` : host ? `Waiting for ${host.name} to start the show` : "Waiting for the host to start the show",
        h("span", { class: "dots" }),
      ),
    );
  }
  update(v);
  return { el, update };
}

function scrIntro(v) {
  const g = v.game;
  const info = g.info || {};
  const el = h(
    "section",
    { class: `tv-scr tv-intro act-${g.act}` },
    h("div", { class: "beam b1" }),
    h("div", { class: "beam b2" }),
    h("p", { class: "ti-act", text: `Act ${ROMAN[g.actNo]} of ${ROMAN[g.actCount]}` }),
    h("h2", { class: "ti-title", text: info.title }),
    h("p", { class: "ti-tag", text: info.tag }),
    h(
      "ol",
      { class: "ti-rules" },
      (info.rules || []).map((r, i) => h("li", { style: { "--i": i } }, h("span", { class: "rule-n", text: i + 1 }), h("span", { text: r }))),
    ),
  );
  audio.stopMusic(0.3);
  audio.rimshot();
  later(900, () => say(info.say));
  return { el };
}

function scrWrite(v) {
  const g = v.game;
  const prog = h("div");
  let heading;
  if (g.kind === "write") {
    heading = h(
      "div",
      { class: "tw-head" },
      h("h2", { class: "tv-poster", text: "Check your phones" }),
      h("p", { class: "tv-sub", text: g.mode === "cards" ? "Everyone has two prompts. Pick the best card from your hand." : g.mode === "write" ? "Everyone has two prompts. Write the funniest thing you can." : "Everyone has two prompts. Write something funny, or play a card from your hand." }),
    );
  } else if (g.kind === "hot-write") {
    const judge = P(g.judge);
    heading = h(
      "div",
      { class: "tw-head hot" },
      h("div", { class: "hot-seat" }, h("div", { class: "seat-glow" }, avatar(judge, { size: "xxl" })), h("p", { class: "hs-label" }, h("span", { text: "In the Hot Seat" }), h("b", { text: judge ? judge.name : "?" }))),
      h("div", { class: "hot-right" }, promptEl(g.prompt, { cls: "tv-board" }), h("p", { class: "tv-sub", text: `Everyone except ${judge ? judge.name : "the judge"}: answer this one on your phone.` })),
    );
  } else {
    heading = h("div", { class: "tw-head closer" }, h("h2", { class: "tv-poster small", text: "The Closer" }), promptEl(g.prompt, { cls: "tv-board" }), h("p", { class: "tv-sub", text: "Everybody answers. Biggest points of the night." }));
  }
  const el = h("section", { class: `tv-scr tv-write k-${g.kind}` }, h("div", { class: "tv-timer" }, timerRing(g, { size: 120 })), heading, prog);
  let doneCount = -1;
  function update(v2) {
    const p = v2.game.prog || [];
    const d = p.filter((x) => x.done >= x.of).length + p.reduce((a, x) => a + x.done, 0);
    if (doneCount >= 0 && d > doneCount) audio.chip(d);
    doneCount = d;
    fill(prog, progGrid(p, { label: g.kind === "hot-write" ? "Writing for the judge" : "" }));
  }
  update(v);
  if (g.kind === "hot-write") later(500, () => say([`${nameOf(g.judge)}, you're in the hot seat.`, g.prompt]));
  else if (g.kind === "closer-write") later(500, () => say(["The closer.", g.prompt]));
  else later(400, () => say("Check your phones. Two prompts each."));
  requestAnimationFrame(() => el.querySelectorAll(".board-t").forEach((t) => fitText(t, { min: 26, max: 46, maxH: 130 })));
  return { el, update };
}

function scrVote(v) {
  const g = v.game;
  const voters = h("div", { class: "tv-voters" });
  const cards = g.answers.map((text, i) => cardEl(text, { cls: `tv-card duel-card side-${i ? "b" : "a"}` }));
  const el = h(
    "section",
    { class: "tv-scr tv-vote" },
    h("div", { class: "tv-timer" }, timerRing(g, { size: 110 })),
    h("p", { class: "tv-kicker", text: `Duel ${g.duelNo} of ${g.duelCount}` }),
    promptEl(g.prompt, { cls: "tv-board" }),
    h("div", { class: "tv-duel" }, cards[0], h("span", { class: "tv-vs", text: "VS" }), cards[1]),
    h("div", { class: "tv-vote-foot" }, h("p", { class: "tvf-l" }, icon("vote"), "Vote on your phone"), voters),
  );
  let seen = 0;
  function update(v2) {
    const ids = v2.game.voted || [];
    if (ids.length > seen) audio.vote();
    seen = ids.length;
    fill(voters, ...ids.map((id) => avatar(P(id), { size: "m", cls: "pop-in" })), h("span", { class: "tvf-c", text: `${ids.length}/${Math.max(ids.length, v2.game.voters)}` }));
  }
  update(v);
  audio.stopMusic(0.4);
  audio.whoosh();
  later(350, () => say([g.prompt, g.answers[0], "or", g.answers[1]]));
  requestAnimationFrame(() => el.querySelectorAll(".board-t").forEach((t) => fitText(t, { min: 28, max: 50, maxH: 130 })));
  return { el, update };
}

function scrReveal(v) {
  const g = v.game;
  const total = g.sides[0].votes.length + g.sides[1].votes.length;
  // the chips land alternately, starting at 0.3 s
  let k = 0;
  const order = [];
  const maxLen = Math.max(g.sides[0].votes.length, g.sides[1].votes.length);
  for (let i = 0; i < maxLen; i++) for (let s = 0; s < 2; s++) if (g.sides[s].votes[i]) order.push([s, g.sides[s].votes[i]]);
  const chipDelay = (idx) => 0.35 + idx * 0.22;
  const chipsFor = (s) =>
    order
      .map(([side, id], idx) => (side === s ? avatar(P(id), { size: "m", cls: "chip-drop", style: { "--d": `${chipDelay(idx)}s` } }) : null))
      .filter(Boolean);
  const doneAt = chipDelay(order.length) + 0.25;
  const sides = g.sides.map((s, i) => {
    const stamp = s.sweep ? stampEl("Killed it!", "kill") : !s.votes.length && total >= 2 ? stampEl("Tough crowd", "tough") : null;
    if (stamp) stamp.style.setProperty("--d", `${doneAt + 0.5}s`);
    const card = cardEl(s.text, { cls: `tv-card duel-card side-${i ? "b" : "a"}${s.win ? " win" : ""}${!s.win && !g.tie ? " lose" : ""}`, tag: stamp, style: { "--d": `${doneAt}s` } });
    const chipBox = h("div", { class: "tv-chips" }, chipsFor(i));
    return h(
      "div",
      { class: "tv-rside" },
      card,
      chipBox,
      h("div", { class: "tv-rmeta", style: { "--d": `${doneAt}s` } }, h("span", { class: "tv-vcount" }, h("b", { text: s.votes.length }), s.votes.length === 1 ? " vote" : " votes"), whoTag(s.pid, { pts: s.pts, card: s.card, auto: s.auto })),
    );
  });
  const el = h(
    "section",
    { class: "tv-scr tv-reveal" },
    h("p", { class: "tv-kicker", text: `Duel ${g.duelNo} of ${g.duelCount}` }),
    promptEl(g.prompt, { cls: "tv-board" }),
    h("div", { class: "tv-duel reveal" }, sides[0], h("span", { class: "tv-vs dim", text: "VS" }), sides[1]),
    g.tie ? h("p", { class: "tv-tie", style: { "--d": `${doneAt}s` }, text: total ? "Dead heat! The points are split." : "Nobody voted. The points are split." }) : null,
  );
  voice.stop();
  order.forEach((_, idx) => later(chipDelay(idx) * 1000, () => audio.chip(idx)));
  const sweep = g.sides.find((s) => s.sweep);
  const bomb = g.sides.find((s) => !s.votes.length && total >= 2);
  later(doneAt * 1000 + 450, () => {
    if (sweep) {
      audio.stamp();
      audio.applause(2.6);
      later(400, () => say(`${nameOf(sweep.pid)} killed it!`));
    } else if (bomb) {
      audio.stamp();
      later(250, () => audio.trombone());
    } else {
      audio.ding(g.tie ? 0 : 4);
      const w = g.sides.find((s) => s.win);
      if (w) later(300, () => say(`${nameOf(w.pid)} takes it.`));
    }
  });
  requestAnimationFrame(() => el.querySelectorAll(".board-t").forEach((t) => fitText(t, { min: 26, max: 44, maxH: 110 })));
  return { el };
}

function scrScores(v) {
  const g = v.game;
  const max = Math.max(1, ...g.ranking.map((r) => r.score));
  const rows = g.ranking.map((r, i) => {
    const p = P(r.id);
    const d = r.score - (r.prev || 0);
    return h(
      "li",
      { class: `tvs-row${r.left ? " gone" : ""}`, style: { "--i": i, "--from": (r.prev / max).toFixed(3), "--to": (r.score / max).toFixed(3) } },
      h("span", { class: "tvs-rank", text: r.rank || i + 1 }),
      avatar(p, { size: "m" }),
      h("span", { class: "tvs-name", text: p ? p.name : "?" }),
      h("span", { class: "tvs-bar" }, h("span", { class: "tvs-fill", style: { "--c": p ? p.color : "#999" } })),
      h("span", { class: "tvs-score", text: fmt(r.score) }),
      d ? h("span", { class: "tvs-d", text: `+${fmt(d)}` }) : h("span", { class: "tvs-d zero", text: "" }),
    );
  });
  const el = h(
    "section",
    { class: `tv-scr tv-scores${g.ranking.length > 7 ? " dense" : ""}` },
    h("h2", { class: "tv-poster small", text: "The leaderboard" }),
    h("ol", { class: "tvs-list" }, rows),
    g.nextInfo ? h("p", { class: "tvs-next" }, "Next up: ", h("b", { text: g.nextInfo.title })) : null,
  );
  audio.whoosh();
  later(600, () => g.ranking.slice(0, 3).forEach((_, i) => later(i * 160, () => audio.ding(7 - i * 2))));
  const leader = g.ranking[0];
  if (leader && leader.score > 0) later(900, () => say(`${nameOf(leader.id)} leads with ${fmt(leader.score)}.`));
  return { el };
}

function judgePanel(g, text) {
  const j = P(g.judge);
  return h("div", { class: "judge-panel" }, h("div", { class: "seat-glow" }, avatar(j, { size: "xxl" })), h("p", { class: "jp-n", text: j ? j.name : "?" }), h("p", { class: "jp-t", text }));
}

function answerGrid(list, { numbered = true, cls = "" } = {}) {
  const n = list.length;
  return h(
    "div",
    { class: `tv-agrid n${n} ${cls}` },
    list.map((a, i) => cardEl(a.text, { cls: "tv-card agrid-card", style: { "--k": i }, tag: numbered ? h("span", { class: "num", text: `#${i + 1}` }) : null })),
  );
}

function scrHotPick(v) {
  const g = v.game;
  const panelText = h("p", { class: "jp-t" });
  const el = h(
    "section",
    { class: "tv-scr tv-hotpick" },
    h("div", { class: "tv-timer" }, timerRing(g, { size: 110 })),
    h("div", { class: "hp-left" }, judgePanel(g, ""), panelText),
    h("div", { class: "hp-right" }, promptEl(g.prompt, { cls: "tv-board" }), answerGrid(g.list), h("p", { class: "hp-foot" }, icon("vote"), "Everyone else: tap your favourite for a crowd vote")),
  );
  let picked = false;
  function update(v2) {
    const g2 = v2.game;
    panelText.textContent = g2.picked ? "has made a pick!" : "is choosing a favourite…";
    el.classList.toggle("picked", g2.picked);
    if (g2.picked && !picked) audio.stamp();
    picked = g2.picked;
  }
  update(v);
  audio.stopMusic(0.4);
  audio.whoosh();
  later(400, () => say([g.prompt, ...g.list.map((a, i) => `Number ${i + 1}. ${a.text}`)]));
  requestAnimationFrame(() => el.querySelectorAll(".board-t").forEach((t) => fitText(t, { min: 22, max: 38, maxH: 92 })));
  return { el, update };
}

function scrHotGuess(v) {
  const g = v.game;
  const el = h(
    "section",
    { class: "tv-scr tv-hotguess" },
    h("div", { class: "tv-timer" }, timerRing(g, { size: 110 })),
    h("p", { class: "tv-kicker", text: `${nameOf(g.judge)} picked` }),
    h("div", { class: "hg-card" }, h("div", { class: "spot-disc" }), cardEl(g.chosen.text, { cls: "tv-card hero-card" })),
    h("h2", { class: "tv-poster small", text: `Who wrote it, ${nameOf(g.judge)}?` }),
    h("div", { class: "hg-cands" }, g.candidates.map((id, i) => h("div", { class: "hg-one", style: { "--i": i } }, avatar(P(id), { size: "xl" }), h("span", { text: nameOf(id) })))),
  );
  audio.drumroll(1.4);
  later(300, () => say([g.chosen.text, `${nameOf(g.judge)}, who wrote it?`]));
  return { el };
}

function scrHotReveal(v) {
  const g = v.game;
  const win = g.list.find((a) => a.aid === g.pick);
  const rest = g.list.filter((a) => a.aid !== g.pick);
  const guessText = g.asleep
    ? `${nameOf(g.judge)} ran out of time. The crowd picked this one.`
    : g.guess == null
      ? `${nameOf(g.judge)} didn't guess.`
      : g.guessRight
        ? `${nameOf(g.judge)} guessed ${nameOf(g.guess)}. Correct! +${g.guessPts}`
        : `${nameOf(g.judge)} guessed ${nameOf(g.guess)}. Nope!`;
  const el = h(
    "section",
    { class: "tv-scr tv-hotreveal" },
    h("p", { class: "tv-kicker", text: g.asleep ? "The crowd's pick" : `${nameOf(g.judge)}'s pick` }),
    promptEl(g.prompt, { cls: "tv-board", fill: win.text }),
    h(
      "div",
      { class: "hr-main" },
      h(
        "div",
        { class: "hr-hero" },
        cardEl(win.text, { cls: "tv-card hero-card win", tag: stampEl(g.asleep ? "Crowd pick" : "Judge's pick", "kill") }),
        whoTag(win.pid, { pts: win.pts, card: win.card, auto: win.auto, cls: "big" }),
        h("p", { class: `hr-guess${g.guessRight ? " right" : g.guess != null ? " wrong" : ""}` }, g.guessRight ? "✓ " : g.guess != null ? "✗ " : "", guessText),
      ),
      h(
        "div",
        { class: `hr-rest n${rest.length}` },
        rest.map((a, i) => h("div", { class: "hr-one", style: { "--i": i } }, cardEl(a.text, { cls: "tv-card mini" }), whoTag(a.pid, { pts: a.pts, card: a.card, auto: a.auto, cls: "small" }))),
      ),
    ),
  );
  voice.stop();
  audio.stamp();
  later(500, () => (g.guessRight ? (audio.ding(7), audio.applause(1.6, 0.08)) : g.guess != null ? audio.buzzer() : null));
  later(700, () => say([`${nameOf(win.pid)} wrote it.`, g.guess != null ? (g.guessRight ? "Mind reader!" : `Not ${nameOf(g.guess)}.`) : ""]));
  requestAnimationFrame(() => el.querySelectorAll(".board-t").forEach((t) => fitText(t, { min: 22, max: 38, maxH: 92 })));
  return { el };
}

function scrCloserVote(v) {
  const g = v.game;
  const voters = h("div", { class: "tv-voters" });
  const el = h(
    "section",
    { class: "tv-scr tv-closervote" },
    h("div", { class: "tv-timer" }, timerRing(g, { size: 110 })),
    h("p", { class: "tv-kicker", text: "The Closer" }),
    promptEl(g.prompt, { cls: "tv-board" }),
    answerGrid(g.list),
    h("div", { class: "tv-vote-foot" }, h("p", { class: "tvf-l" }, "🎤 Give your mic to the best one. 🍅 Throw a tomato if you must."), voters),
  );
  let seen = 0;
  function update(v2) {
    const ids = v2.game.voted || [];
    if (ids.length > seen) audio.vote();
    seen = ids.length;
    fill(voters, ...ids.map((id) => avatar(P(id), { size: "m", cls: "pop-in" })), h("span", { class: "tvf-c", text: `${ids.length}/${Math.max(ids.length, v2.game.voters)}` }));
  }
  update(v);
  audio.stopMusic(0.4);
  audio.whoosh();
  later(400, () => say([g.prompt, ...g.list.map((a, i) => `Number ${i + 1}. ${a.text}`)]));
  requestAnimationFrame(() => el.querySelectorAll(".board-t").forEach((t) => fitText(t, { min: 22, max: 40, maxH: 92 })));
  return { el };
}

function scrCloserReveal(v) {
  const g = v.game;
  const n = g.order.length;
  const step = g.step / 1000;
  // keep the cards where they were during the vote (by answer id); light them up in score order
  const byAid = g.order.slice().sort((a, b) => a.aid - b.aid);
  const rankOf = new Map(g.order.map((a, i) => [a.aid, i]));
  const el = h(
    "section",
    { class: "tv-scr tv-closerreveal" },
    h("p", { class: "tv-kicker", text: "The Closer · counting up to the winner" }),
    promptEl(g.prompt, { cls: "tv-board" }),
    h(
      "div",
      { class: `tv-agrid n${n} reveal` },
      byAid.map((a) => {
        const i = rankOf.get(a.aid);
        const d = `${0.6 + i * step}s`;
        const splats = a.tomatoes.map((_, k) => h("span", { class: "splat", style: { "--x": `${15 + ((k * 37) % 70)}%`, "--y": `${20 + ((k * 53) % 55)}%`, "--r": `${(k * 67) % 360}deg` } }));
        return h(
          "div",
          { class: `cr-cell${a.top ? " top" : ""}`, style: { "--d": d } },
          cardEl(a.text, { cls: `tv-card agrid-card${a.top ? " win" : ""}`, tag: [h("span", { class: "num", text: `#${n - i}` }), ...splats, a.top ? stampEl("The Closer", "kill") : null] }),
          h("div", { class: "cr-meta" }, whoTag(a.pid, { pts: a.pts, card: a.card, auto: a.auto, cls: "small" }), h("span", { class: "cr-mics" }, h("b", { text: a.mics.length }), " 🎤", a.tomatoes.length ? h("span", { class: "cr-toms", text: `  ${a.tomatoes.length} 🍅` }) : null)),
        );
      }),
    ),
  );
  voice.stop();
  g.order.forEach((a, i) =>
    later((0.6 + i * step) * 1000, () => {
      if (a.top) {
        audio.fanfare();
        audio.applause(3.2);
        confetti({ count: 140 });
        later(600, () => say(`The closer goes to ${nameOf(a.pid)}!`));
      } else {
        audio.ding(i);
        if (a.tomatoes.length) later(250, () => audio.splat());
      }
    }),
  );
  if (n > 1) later(300, () => audio.drumroll(Math.min(3, n * step * 0.6)));
  requestAnimationFrame(() => el.querySelectorAll(".board-t").forEach((t) => fitText(t, { min: 22, max: 36, maxH: 86 })));
  return { el };
}

function scrFinal(v) {
  const g = v.game;
  const rows = g.ranking;
  const top3 = rows.slice(0, 3);
  const podium = [top3[1], top3[0], top3[2]].filter(Boolean);
  const host = P(v.host);
  const status = h("p", { class: "tvf-status" });
  const el = h(
    "section",
    { class: "tv-scr tv-final" },
    h("div", { class: "beam b1" }),
    h("div", { class: "beam b2" }),
    h("p", { class: "tv-kicker", text: "That's the show!" }),
    h("h2", { class: "tv-poster", text: "Tonight's headliner" }),
    h(
      "div",
      { class: "tvf-body" },
      h(
        "div",
        { class: "podium tv" },
        podium.map((r) => {
          const p = P(r.id);
          const place = top3.indexOf(r) + 1;
          return h("div", { class: `pod pod-${place}` }, avatar(p, { size: place === 1 ? "xxl" : "xl" }), h("span", { class: "pod-name", text: p ? p.name : "?" }), h("span", { class: "pod-score", text: fmt(r.score) }), h("span", { class: "pod-block", text: r.rank }));
        }),
      ),
      g.awards.length
        ? h(
            "div",
            { class: "awards tv" },
            g.awards.map((a, i) => h("div", { class: "award", style: { "--i": i } }, h("span", { class: "award-t", text: a.title }), h("span", { class: "award-who" }, avatar(P(a.pid), { size: "s" }), nameOf(a.pid)), h("span", { class: "award-d", text: a.desc }))),
          )
        : null,
    ),
    rows.length > 3 ? h("div", { class: "tvf-rest" }, rows.slice(3).map((r) => h("span", { class: "tvf-r" }, h("b", { text: r.rank }), avatar(P(r.id), { size: "xs" }), nameOf(r.id), h("i", { text: fmt(r.score) })))) : null,
    status,
  );
  const paint = (v2) => {
    const hp = P(v2.host);
    status.textContent = `${hp ? hp.name : "The host"} can start another show from their phone.`;
  };
  paint(v);
  voice.stop();
  audio.stopMusic(0.3);
  later(200, () => {
    audio.fanfare();
    audio.applause(3.5);
    confetti({ count: 200, from: "sides" });
  });
  const w = rows[0];
  if (w) later(1300, () => say(`That's the show! Tonight's headliner is ${nameOf(w.id)}, with ${fmt(w.score)} points.`));
  return { el, update: paint };
}

function scrLoading() {
  return { el: h("section", { class: "tv-scr tv-center" }, h("div", { class: "spinner" }), h("p", { class: "muted", text: "Setting up the stage…" })) };
}

// ---------- reactions ----------
function showReact(m) {
  const p = P(m.id);
  if (m.e === "tomato") {
    const el = h("span", { class: "tv-splat", style: { left: `${18 + Math.random() * 64}%`, top: `${22 + Math.random() * 50}%`, "--r": `${Math.random() * 360}deg` } });
    fx.append(el);
    audio.splat();
    setTimeout(() => el.remove(), 2400);
    return;
  }
  const el = h(
    "span",
    { class: "tv-float", style: { left: `${6 + Math.random() * 88}%`, "--dx": `${(Math.random() - 0.5) * 120}px`, "--c": p ? p.color : "#fff" } },
    h("span", { class: "tf-e", text: REACT_EMOJI[m.e] || "✨" }),
    p ? h("span", { class: "tf-n", text: p.name }) : null,
  );
  fx.append(el);
  setTimeout(() => el.remove(), 2600);
}

// ---------- shell ----------
function render() {
  const v = S.v;
  let key;
  let make;
  if (!v) [key, make] = S.resuming ? ["loading", scrLoading] : ["home", scrHome];
  else if (!v.game) [key, make] = ["lobby", scrLobby];
  else {
    const g = v.game;
    switch (g.kind) {
      case "intro":
        [key, make] = [`intro:${g.actNo}`, scrIntro];
        break;
      case "write":
      case "hot-write":
      case "closer-write":
        [key, make] = [`w:${g.kind}:${g.turn || 0}`, scrWrite];
        break;
      case "vote":
        [key, make] = [`v:${g.duelNo}`, scrVote];
        break;
      case "reveal":
        [key, make] = [`r:${g.duelNo}`, scrReveal];
        break;
      case "scores":
        [key, make] = [`s:${g.actNo}`, scrScores];
        break;
      case "hot-pick":
        [key, make] = [`hp:${g.turn}`, scrHotPick];
        break;
      case "hot-guess":
        [key, make] = [`hg:${g.turn}`, scrHotGuess];
        break;
      case "hot-reveal":
        [key, make] = [`hr:${g.turn}`, scrHotReveal];
        break;
      case "closer-vote":
        [key, make] = ["cv", scrCloserVote];
        break;
      case "closer-reveal":
        [key, make] = ["cr", scrCloserReveal];
        break;
      case "final":
        [key, make] = ["final", scrFinal];
        break;
      default:
        [key, make] = ["loading", scrLoading];
    }
  }
  if (key !== S.key) {
    S.key = key;
    S.scr = make(v);
    fill(tvMain, S.scr.el);
    document.body.dataset.screen = key.split(":")[0];
    const kind = v ? (v.game ? v.game.kind : "lobby") : "home";
    if (MUSIC_KINDS.has(kind) && S.musicOn && S.unlocked) audio.startMusic();
    else if (!MUSIC_KINDS.has(kind)) audio.stopMusic(0.4);
  } else if (S.scr && S.scr.update) S.scr.update(v);
  topBar(v);
}

// The last few seconds of a timer tick on the big screen.
onTick((t) => {
  const g = S.v && S.v.game;
  if (!g || g.endsAt == null || !["write", "hot-write", "closer-write", "vote", "hot-pick", "closer-vote"].includes(g.kind)) return;
  const left = Math.ceil((g.endsAt - t) / 1000);
  if (left !== S.lastTick && left <= 5 && left >= 1) audio.tick(left <= 2);
  S.lastTick = left;
});

function unlock() {
  audio.unlock();
  S.unlocked = true;
  unlockEl.classList.add("gone");
  const kind = S.v ? (S.v.game ? S.v.game.kind : "lobby") : "home";
  if (MUSIC_KINDS.has(kind) && S.musicOn) audio.startMusic();
}

function paintCtrl() {
  fill(ctrl, 
    h("button", { class: `ctl${S.sound ? "" : " off"}`, type: "button", title: "Sound", onclick: () => toggle("sound") }, icon(S.sound ? "sound" : "mute"), h("span", { text: S.sound ? "Sound" : "Muted" })),
    h("button", { class: `ctl${S.musicOn ? "" : " off"}`, type: "button", title: "Music while writing", onclick: () => toggle("music") }, h("span", { class: "ctl-e", text: "♪" }), h("span", { text: S.musicOn ? "Music" : "No music" })),
    voice.ok ? h("button", { class: `ctl${S.voiceOn ? "" : " off"}`, type: "button", title: "Host voice reads prompts aloud", onclick: () => toggle("voice") }, icon("voice"), h("span", { text: S.voiceOn ? "Host voice" : "No voice" })) : null,
    h("button", { class: "ctl", type: "button", title: "Full screen", onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {})) }, icon("full"), h("span", { text: "Full screen" })),
    S.v ? h("button", { class: "ctl", type: "button", title: "Leave this room on this screen", onclick: leaveTv }, icon("x"), h("span", { text: "Leave" })) : null,
  );
}

function toggle(what) {
  unlock();
  if (what === "sound") {
    S.sound = !S.sound;
    st.set("sound", S.sound);
    audio.setMuted(!S.sound);
    if (!S.sound) voice.stop();
  } else if (what === "music") {
    S.musicOn = !S.musicOn;
    st.set("music", S.musicOn);
    const kind = S.v ? (S.v.game ? S.v.game.kind : "lobby") : "home";
    if (S.musicOn && MUSIC_KINDS.has(kind)) audio.startMusic();
    else audio.stopMusic(0.3);
  } else if (what === "voice") {
    S.voiceOn = !S.voiceOn;
    voice.on = S.voiceOn;
    st.set("voice", S.voiceOn);
    if (!S.voiceOn) voice.stop();
  }
  paintCtrl();
}

function leaveTv() {
  st.del("room");
  S.v = null;
  S.key = null;
  S.seenPlayers.clear();
  try {
    net.ws && net.ws.close();
  } catch {}
  audio.stopMusic(0.2);
  voice.stop();
  render();
  paintCtrl();
}

function onMsg(m) {
  switch (m.t) {
    case "joined":
      st.set("room", { code: m.code });
      S.resuming = false;
      S.busy = false;
      break;
    case "state": {
      const first = !S.v;
      S.v = m;
      S.busy = false;
      if (first) for (const p of m.players) S.seenPlayers.add(p.id);
      render();
      if (first) paintCtrl();
      break;
    }
    case "error":
      S.busy = false;
      S.resuming = false;
      if (m.code === "noroom") st.del("room");
      toast(m.msg || "Something went wrong.");
      render();
      break;
    case "gone":
      st.del("room");
      S.v = null;
      render();
      paintCtrl();
      toast("That room has closed.");
      break;
    case "react":
      showReact(m);
      break;
  }
}

export function startTv() {
  installWall();
  document.body.classList.add("tv");
  const app = document.getElementById("app");
  tvTop = h("header", { class: "tv-top" });
  tvMain = h("main", { class: "tv-main" });
  stage = h("div", { class: "stage" }, tvTop, tvMain);
  fx = h("div", { class: "tv-fx", "aria-hidden": "true" });
  ctrl = h("div", { class: "tv-ctrl" });
  unlockEl = h("button", { class: "tv-unlock", type: "button", onclick: unlock }, icon("sound"), "Click anywhere to turn the sound on");
  fill(app, h("div", { class: "wall", "aria-hidden": "true" }), h("div", { class: "tv-spot", "aria-hidden": "true" }), h("div", { class: "tv-floor", "aria-hidden": "true" }), stage, fx, ctrl, unlockEl);
  fit();
  addEventListener("resize", fit);
  audio.setMuted(!S.sound);
  window.addEventListener("pointerdown", () => !S.unlocked && unlock(), { passive: true });
  window.addEventListener("keydown", () => !S.unlocked && unlock());
  let idle;
  window.addEventListener("pointermove", () => {
    document.body.classList.add("show-ctrl");
    clearTimeout(idle);
    idle = setTimeout(() => document.body.classList.remove("show-ctrl"), 2600);
  });
  net = new Net({
    onMsg,
    onOpen() {
      const r = st.get("room");
      if (r && r.code) {
        S.resuming = true;
        net.send({ t: "watch", code: r.code });
      }
      render();
    },
  });
  setClock(() => net.serverNow());
  if (st.get("room")) S.resuming = true;
  net.connect();
  paintCtrl();
  render();
  if (params.has("dev")) window.__tv = { S, net, render };
}
