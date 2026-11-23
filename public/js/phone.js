// The phone: join a room, write or play cards, vote, judge, react.
// Every screen is rebuilt only when its key changes; otherwise it gets update(v),
// so a half-typed answer survives other players' progress pinging in.

import { Net } from "./net.js";
import { h, fill, avatar, promptEl, cardEl, timerBar, fmt, toast, store, setClock, qrSvg, logoEl, howTo, icon, ROMAN, ordinal, vibrate, installWall } from "./ui.js";
import { audio } from "./audio.js";
import { confetti } from "./confetti.js";

const EMOJIS = ["😎", "🤡", "🐸", "🦊", "🐙", "👽", "🤠", "🧛", "🦄", "🐔", "🌮", "🥔", "🐧", "🦖", "👻", "🤖", "🐵", "🦉", "🍕", "🧀", "🦝", "🐌", "🦩", "🎩"];
const REACTS = [
  ["lol", "😂"],
  ["clap", "👏"],
  ["fire", "🔥"],
  ["tomato", "🍅"],
  ["dead", "💀"],
];
const REACT_EMOJI = Object.fromEntries(REACTS);
const ACT_SHORT = { h2h: "Head to Head", hot: "The Hot Seat", closer: "The Closer" };
const TIPS = [
  "You get one fresh hand of cards per act.",
  "Out of time? A random card from your hand gets played for you.",
  "Sweep every vote in a duel and you killed it: +200.",
  "In the Hot Seat, the judge earns 200 for guessing who wrote their favourite.",
  "In the Closer, tomatoes cost nothing. They just sting.",
  "Big groups: the top six on the leaderboard take the Hot Seat.",
  "Cards and written answers look exactly the same to the room.",
];

const params = new URLSearchParams(location.search);
const DEV = params.has("dev");
const st = store(params.get("ns") || "");

if (!EMOJIS.includes(st.get("emoji"))) st.set("emoji", EMOJIS[Math.floor(Math.random() * EMOJIS.length)]);

const S = {
  v: null,
  you: null,
  key: null,
  scr: null,
  busy: false,
  resuming: false,
  notice: null,
  urlRoom: (params.get("room") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4),
  name: st.get("name") || "",
  emoji: st.get("emoji"),
  sound: st.get("sound") !== false,
  lastKind: null,
};

let net;
let main;
let top;

// ---------- helpers ----------
const P = (id) => (S.v ? S.v.players.find((p) => p.id === id) || S.v.audience.find((p) => p.id === id) : null);
const nameOf = (id) => P(id)?.name || "Someone";
const meP = () => (S.v ? P(S.v.you) : null);
const isHost = () => !!S.v && S.v.host === S.v.you;
const inviteUrl = (code) => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}?room=${code}`;
const shortHost = () => `${location.host}${location.pathname.replace(/[^/]*$/, "")}`.replace(/\/$/, "");
// Phones make sound only when there's no big screen doing it.
const phoneSfx = () => S.v && !S.v.tv;

function send(m) {
  net.send(m);
}

function sheet(title, body, actions = []) {
  const close = () => {
    wrap.classList.remove("on");
    setTimeout(() => wrap.remove(), 220);
  };
  const wrap = h(
    "div",
    { class: "sheet-wrap", onclick: (e) => e.target === wrap && close() },
    h(
      "div",
      { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "sheet-grab" }),
      h("h3", { class: "sheet-h", text: title }),
      body,
      h(
        "div",
        { class: "sheet-actions" },
        actions.map(([label, cls, fn]) =>
          h("button", {
            class: `btn ${cls}`,
            type: "button",
            text: label,
            onclick: () => {
              close();
              fn && fn();
            },
          }),
        ),
      ),
    ),
  );
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add("on"));
  return close;
}

function confirmSheet(title, text, yes, fn) {
  sheet(title, h("p", { class: "sheet-p", text }), [
    [yes, "primary", fn],
    ["Cancel", "ghost", null],
  ]);
}

function floatReact(e, from = null) {
  const ch = REACT_EMOJI[e];
  if (!ch) return;
  const r = from ? from.getBoundingClientRect() : { left: innerWidth * (0.2 + Math.random() * 0.6), top: innerHeight - 80, width: 0 };
  const el = h("span", { class: "float-react", text: ch, style: { left: `${r.left + r.width / 2}px`, top: `${r.top}px`, "--dx": `${(Math.random() - 0.5) * 80}px` } });
  document.body.append(el);
  setTimeout(() => el.remove(), 1600);
}

function reactBar() {
  return h(
    "div",
    { class: "react-bar", role: "group", "aria-label": "React" },
    REACTS.map(([k, ch]) =>
      h(
        "button",
        {
          class: "react-btn",
          type: "button",
          "aria-label": k,
          onclick: (ev) => {
            send({ t: "react", e: k });
            floatReact(k, ev.currentTarget);
            vibrate(8);
          },
        },
        ch,
      ),
    ),
  );
}

function kicker(text, extra = null) {
  return h("div", { class: "kick" }, h("span", { class: "kick-t", text }), extra);
}

function actPill(g) {
  return h("span", { class: `act-pill act-${g.act}` }, `Act ${ROMAN[g.actNo] || g.actNo}`, h("i"), ACT_SHORT[g.act] || "");
}

function whoTag(pid, { pts = null, card = false, auto = false } = {}) {
  const p = P(pid);
  return h(
    "div",
    { class: "who" },
    avatar(p, { size: "s" }),
    h("span", { class: "who-n", text: p ? p.name : "Someone" }),
    card ? h("span", { class: "src", title: auto ? "Played for them when time ran out" : "Played a card" }, icon("cards"), auto ? "time's up" : "card") : h("span", { class: "src", title: "Wrote it" }, icon("pen"), "wrote it"),
    pts != null ? h("span", { class: `pts${pts ? "" : " zero"}`, text: `+${fmt(pts)}` }) : null,
  );
}

function voterRow(ids) {
  if (!ids || !ids.length) return h("div", { class: "voters none", text: "no votes" });
  return h("div", { class: "voters" }, ids.map((id) => avatar(P(id), { size: "xs" })));
}

function progressRow(prog, label = "Still writing") {
  const waiting = (prog || []).filter((x) => x.done < x.of);
  const done = (prog || []).filter((x) => x.done >= x.of);
  return h(
    "div",
    { class: "prog" },
    h("p", { class: "prog-l", text: waiting.length ? `${label}:` : "Everyone's in!" }),
    h(
      "div",
      { class: "prog-avs" },
      waiting.map((x) => h("span", { class: "prog-one wait" }, avatar(P(x.id), { size: "s" }), h("span", { text: P(x.id)?.name || "?" }))),
      done.map((x) => h("span", { class: "prog-one ok" }, avatar(P(x.id), { size: "s" }))),
    ),
  );
}

// ---------- screens ----------
function scrLoading() {
  return { el: h("section", { class: "scr center" }, h("div", { class: "spinner" }), h("p", { class: "muted", text: "Finding your seat…" })) };
}

function scrHome() {
  const notice = S.notice;
  S.notice = null;
  const joinMode = !!S.urlRoom;
  const nameIn = h("input", {
    class: "in name-in",
    id: "in-name",
    maxlength: 12,
    placeholder: "Your name",
    value: S.name,
    autocomplete: "nickname",
    enterkeyhint: "go",
    spellcheck: "false",
    "aria-label": "Your name",
  });
  const codeIn = h("input", {
    class: "in code-in",
    maxlength: 4,
    placeholder: "CODE",
    value: S.urlRoom,
    autocapitalize: "characters",
    autocomplete: "off",
    spellcheck: "false",
    enterkeyhint: "go",
    "aria-label": "Room code",
  });
  const emojiBtn = h(
    "button",
    { class: "av-pick", type: "button", "aria-label": "Change your avatar" },
    h("span", { class: "av-pick-e", text: S.emoji }),
    h("span", { class: "av-pick-hint", text: "tap" }),
  );
  emojiBtn.onclick = () => {
    audio.unlock();
    const i = EMOJIS.indexOf(S.emoji);
    S.emoji = EMOJIS[(i + 1) % EMOJIS.length];
    st.set("emoji", S.emoji);
    emojiBtn.firstChild.textContent = S.emoji;
    emojiBtn.classList.remove("bump");
    void emojiBtn.offsetWidth;
    emojiBtn.classList.add("bump");
    audio.pop(i % 5);
  };
  codeIn.oninput = () => {
    codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  };
  const go = (kind) => {
    audio.unlock();
    const name = nameIn.value.trim();
    if (!name) {
      nameIn.focus();
      nameIn.classList.remove("shake");
      void nameIn.offsetWidth;
      nameIn.classList.add("shake");
      return toast("Pick a name first.");
    }
    S.name = name;
    st.set("name", name);
    if (kind === "join") {
      const code = codeIn.value.trim().toUpperCase();
      if (code.length !== 4) {
        codeIn.focus();
        return toast("Room codes are four letters.");
      }
      S.busy = true;
      send({ t: "join", code, name, emoji: S.emoji });
    } else {
      S.busy = true;
      send({ t: "create", name, emoji: S.emoji });
    }
    paint();
  };
  nameIn.onkeydown = (e) => {
    if (e.key === "Enter") go(joinMode || codeIn.value.length === 4 ? "join" : "create");
  };
  codeIn.onkeydown = (e) => {
    if (e.key === "Enter") go("join");
  };
  const hostBtn = h("button", { class: `btn ${joinMode ? "ghost" : "primary"} big wide`, type: "button", onclick: () => go("create") }, icon("mic"), "Host a game");
  const joinBtn = h("button", { class: `btn ${joinMode ? "primary big wide" : "amber"}`, type: "button", onclick: () => go("join") }, joinMode ? `Join room ${S.urlRoom}` : "Join");
  const paint = () => {
    hostBtn.disabled = S.busy;
    joinBtn.disabled = S.busy;
  };
  const form = h(
    "div",
    { class: "panel form" },
    h("div", { class: "who-row" }, emojiBtn, nameIn),
    joinMode
      ? [joinBtn, h("div", { class: "or" }, h("span", { text: "or" })), hostBtn]
      : [hostBtn, h("div", { class: "or" }, h("span", { text: "or join a room" })), h("div", { class: "join-row" }, codeIn, joinBtn)],
  );
  const el = h(
    "section",
    { class: "scr home" },
    h("div", { class: "home-hero" }, h("div", { class: "spot-cone", "aria-hidden": "true" }), logoEl("logo-home"), h("p", { class: "tagline", text: "The party game where the room decides what's funny." })),
    notice ? h("p", { class: "notice", text: notice }) : null,
    form,
    h(
      "a",
      { class: "tv-hint", href: "?tv" },
      icon("tv"),
      h("span", null, h("b", { text: "Got a TV or laptop?" }), " Open big-screen mode on it and the whole room can watch."),
    ),
    h("div", { class: "panel how-panel" }, h("h2", { class: "sub-h", text: "How it works" }), howTo()),
    h("p", { class: "foot muted", text: "3–10 players · one phone each · about 15 minutes" }),
  );
  return { el, update: paint };
}

function scrLobby(v) {
  const el = h("section", { class: "scr lobby" });
  let showQr = false;
  const qrBox = h("div", { class: "qr-box" });
  const plist = h("div", { class: "plist" });
  const settings = h("div", { class: "panel settings" });
  const startBox = h("div", { class: "start-box" });
  const lastBox = h("div");
  const url = inviteUrl(v.code);

  const invite = async () => {
    audio.unlock();
    try {
      if (navigator.share) {
        await navigator.share({ title: "Tough Crowd", text: `Join my Tough Crowd room: ${v.code}`, url });
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Invite link copied");
    } catch {
      toast(url, { ms: 5000 });
    }
  };
  const qrBtn = h(
    "button",
    {
      class: "btn ghost",
      type: "button",
      onclick: () => {
        showQr = !showQr;
        qrBox.classList.toggle("on", showQr);
        qrBtn.classList.toggle("on", showQr);
        if (showQr && !qrBox.firstChild) qrBox.append(h("div", { class: "qr-paper" }, qrSvg(url)), h("p", { class: "muted small", text: "Friends scan this to jump straight in." }));
      },
    },
    icon("qr"),
    "QR code",
  );

  el.append(
    h(
      "div",
      { class: "lobby-head" },
      h("p", { class: "eyebrow", text: "Room code" }),
      h("div", { class: "code-tiles", "aria-label": `Room code ${v.code}` }, [...v.code].map((ch, i) => h("span", { class: "tile", style: { "--i": i }, text: ch }))),
      h("p", { class: "code-sub" }, "Join at ", h("b", { text: shortHost() })),
      h("div", { class: "duo" }, h("button", { class: "btn amber", type: "button", onclick: invite }, icon("share"), "Invite"), qrBtn),
      qrBox,
    ),
    lastBox,
    h("div", { class: "panel" }, h("div", { class: "row-between" }, h("h2", { class: "sub-h", text: "The line-up" }), h("span", { class: "muted small pcount" })), plist),
    settings,
    startBox,
    h("div", { class: "panel how-panel" }, h("h2", { class: "sub-h", text: "How it works" }), howTo()),
    h("a", { class: "tv-hint", href: "?tv", target: "_blank", rel: "noopener" }, icon("tv"), h("span", null, h("b", { text: "Big screen:" }), ` open ${shortHost()}/?tv on a TV or laptop, then enter code ${v.code}.`)),
  );

  const cycleEmoji = () => {
    const taken = new Set([...S.v.players, ...S.v.audience].filter((p) => p.id !== S.v.you).map((p) => p.emoji));
    let i = EMOJIS.indexOf(meP()?.emoji);
    for (let k = 0; k < EMOJIS.length; k++) {
      i = (i + 1) % EMOJIS.length;
      if (!taken.has(EMOJIS[i])) break;
    }
    S.emoji = EMOJIS[i];
    st.set("emoji", S.emoji);
    send({ t: "emoji", emoji: S.emoji });
    audio.pop(i % 5);
  };

  function update(v) {
    const host = isHost();
    const hostP = P(v.host);
    el.querySelector(".pcount").textContent = `${v.players.length}/${v.max}`;
    fill(lastBox, v.last ? h("p", { class: "last-show" }, "Last show's headliner: ", h("b", { text: `${v.last.emoji} ${v.last.name}` }), ` with ${fmt(v.last.score)}`) : "");
    fill(plist, 
      ...v.players.map((p) => {
        const mine = p.id === v.you;
        const av = mine ? h("button", { class: "av-btn", type: "button", "aria-label": "Change your avatar", onclick: cycleEmoji }, avatar(p, { size: "m" })) : avatar(p, { size: "m" });
        return h(
          "div",
          { class: `prow${mine ? " me" : ""}${p.on ? "" : " off"}` },
          av,
          h(
            "div",
            { class: "prow-mid" },
            h("span", { class: "prow-n", text: p.name }),
            h(
              "div",
              { class: "prow-badges" },
              p.id === v.host ? h("span", { class: "badge host" }, icon("crown"), "host") : null,
              p.bot ? h("span", { class: "badge", text: "bot" }) : null,
              mine ? h("span", { class: "badge you", text: "you · tap your face to restyle" }) : null,
              !p.on ? h("span", { class: "badge dim", text: "away" }) : null,
            ),
          ),
          host && !mine
            ? h(
                "button",
                {
                  class: "icon-btn kick",
                  type: "button",
                  "aria-label": `Remove ${p.name}`,
                  onclick: () => confirmSheet(`Remove ${p.name}?`, "They'll be taken out of the room.", "Remove", () => send({ t: "kick", id: p.id })),
                },
                icon("x"),
              )
            : null,
        );
      }),
      ...Array.from({ length: Math.max(0, v.min - v.players.length) }, () => h("div", { class: "prow empty" }, h("span", { class: "av av-m ghost" }), h("span", { class: "prow-n", text: "Waiting for a player…" }))),
      v.audience.length ? h("p", { class: "aud-line muted small" }, `In the audience: ${v.audience.map((a) => a.name).join(", ")}`) : null,
    );

    // settings
    const s = v.settings;
    if (host) {
      const actRow = (key, title, desc) =>
        h(
          "button",
          {
            class: `act-row${s.acts[key] ? " on" : ""}`,
            type: "button",
            "aria-pressed": String(!!s.acts[key]),
            onclick: () => {
              const acts = { ...s.acts, [key]: !s.acts[key] };
              if (!acts.h2h && !acts.hot && !acts.closer) return toast("Keep at least one act in the show.");
              send({ t: "settings", settings: { ...s, acts } });
              audio.tap();
            },
          },
          h("span", { class: "check", "aria-hidden": "true" }, icon("vote")),
          h("span", { class: "act-txt" }, h("b", { text: title }), h("span", { text: desc })),
        );
      const seg = (key, opts) =>
        h(
          "div",
          { class: "seg", role: "group" },
          opts.map(([val, label]) =>
            h("button", {
              class: s[key] === val ? "on" : "",
              type: "button",
              "aria-pressed": String(s[key] === val),
              text: label,
              onclick: () => {
                send({ t: "settings", settings: { ...s, [key]: val } });
                audio.tap();
              },
            }),
          ),
        );
      fill(settings, 
        h("h2", { class: "sub-h", text: "The show" }),
        actRow("h2h", "Head to Head", "Two players, same prompt. The room votes."),
        actRow("hot", "The Hot Seat", "A judge picks a favourite, then guesses who wrote it."),
        actRow("closer", "The Closer", "One prompt for all. Mics for the best, tomatoes for the rest."),
        h("h3", { class: "mini-h", text: "Answers" }),
        seg("answers", [
          ["mix", "Write or card"],
          ["cards", "Cards only"],
          ["write", "Write only"],
        ]),
        h("h3", { class: "mini-h", text: "Pace" }),
        seg("pace", [
          ["relaxed", "Relaxed"],
          ["normal", "Normal"],
          ["quick", "Quick"],
        ]),
        h(
          "button",
          {
            class: `switch-row${s.family ? " on" : ""}`,
            type: "button",
            "aria-pressed": String(!!s.family),
            onclick: () => {
              send({ t: "settings", settings: { ...s, family: !s.family } });
              audio.tap();
            },
          },
          h("span", { class: "act-txt" }, h("b", { text: "Family filter" }), h("span", { text: "Bleeps swearing in written answers." })),
          h("span", { class: "sw", "aria-hidden": "true" }),
        ),
      );
    } else {
      const acts = ["h2h", "hot", "closer"].filter((a) => s.acts[a]).map((a) => ACT_SHORT[a]);
      fill(settings, 
        h("h2", { class: "sub-h", text: "Tonight's show" }),
        h(
          "div",
          { class: "chips" },
          acts.map((a) => h("span", { class: "chip", text: a })),
          h("span", { class: "chip alt", text: { mix: "Write or card", cards: "Cards only", write: "Write only" }[s.answers] }),
          h("span", { class: "chip alt", text: `${s.pace[0].toUpperCase()}${s.pace.slice(1)} pace` }),
          s.family ? h("span", { class: "chip alt", text: "Family filter" }) : null,
        ),
        h("p", { class: "muted small", text: `${hostP ? hostP.name : "The host"} picks the settings.` }),
      );
    }

    // start
    const need = v.min - v.players.filter((p) => !p.left).length;
    const me = meP();
    if (me && me.id && v.role === "audience") {
      fill(startBox, h("p", { class: "notice", text: "The line-up is full, so you're in the audience. You can still vote and react." }));
    } else if (host) {
      const mins = estimate(v);
      fill(startBox, 
        h(
          "button",
          {
            class: "btn primary big wide start",
            type: "button",
            disabled: need > 0 || S.busy,
            onclick: () => {
              audio.unlock();
              S.busy = true;
              send({ t: "start" });
              update(S.v);
            },
          },
          icon("mic"),
          "Start the show",
        ),
        h("p", { class: "muted small center", text: need > 0 ? `Need ${need} more player${need === 1 ? "" : "s"}. Send them the code!` : `About ${mins} minutes with ${v.players.length} players.` }),
        DEV ? h("button", { class: "btn ghost wide", type: "button", onclick: () => send({ t: "addBot" }) }, "Add a bot (dev)") : null,
      );
    } else {
      fill(startBox, h("p", { class: "waiting-line" }, `Waiting for ${hostP ? hostP.name : "the host"} to start the show`, h("span", { class: "dots" })));
    }
  }
  update(v);
  return { el, update };
}

function estimate(v) {
  const n = Math.max(3, v.players.length);
  const pace = { relaxed: 1.35, normal: 1, quick: 0.75 }[v.settings.pace] || 1;
  let s = 0;
  if (v.settings.acts.h2h) s += 70 + n * 22;
  if (v.settings.acts.hot) s += Math.min(n, 6) * 75;
  if (v.settings.acts.closer) s += 90 + n * 4;
  return Math.max(3, Math.round((s * pace) / 60));
}

function scrIntro(v) {
  const g = v.game;
  const info = g.info || {};
  const el = h(
    "section",
    { class: `scr intro act-${g.act}` },
    h("p", { class: "eyebrow", text: `Act ${ROMAN[g.actNo] || g.actNo} of ${ROMAN[g.actCount] || g.actCount}` }),
    h("h2", { class: "poster", text: info.title || "" }),
    h("p", { class: "intro-tag", text: info.tag || "" }),
    h(
      "ol",
      { class: "rules" },
      (info.rules || []).map((r, i) => h("li", { style: { "--i": i } }, h("span", { class: "rule-n", text: i + 1 }), h("span", { text: r }))),
    ),
    timerBar(g, { calm: true }),
  );
  if (phoneSfx()) audio.rimshot();
  vibrate([20, 60, 20]);
  return { el };
}

function scrWrite(v) {
  const g = v.game;
  const me = g.me;
  const t = me.todo[0];
  const mode = g.mode;
  let sel = null;
  let sending = false;
  let handIds = "";

  const label =
    g.kind === "write" ? `Prompt ${me.of - me.todo.length + 1} of ${me.of}` : g.kind === "hot-write" ? `For ${nameOf(g.judge)} in the Hot Seat` : "The Closer · everyone answers";
  const ta =
    mode !== "cards"
      ? h("textarea", {
          class: "card-input",
          maxlength: 70,
          rows: 3,
          placeholder: mode === "write" ? "Write your answer…" : "Write your answer…",
          enterkeyhint: "send",
          autocapitalize: "sentences",
          "aria-label": "Your answer",
        })
      : null;
  const count = h("span", { class: "count", text: "70" });
  const sendBtn = h("button", { class: "btn primary big wide send", type: "button" });
  const hand = h("div", { class: "hand" });
  const redrawBtn = h("button", { class: "chip-btn", type: "button" }, icon("redraw"), h("span", { class: "rd-t", text: "New hand" }));

  const refreshSend = () => {
    const text = ta ? ta.value.trim() : "";
    fill(sendBtn, sel != null || mode === "cards" ? icon("cards") : icon("pen"), sending ? "Sending…" : sel != null ? "Play this card" : mode === "cards" ? "Tap a card to play it" : "Send answer");
    sendBtn.disabled = sending || (sel == null && !text);
    if (ta) count.textContent = String(70 - [...ta.value].length);
  };
  const paintHand = (cards) => {
    fill(hand, 
      ...cards.map((c) =>
        cardEl(c.text, {
          cls: `hcard${sel === c.id ? " sel" : ""}`,
          tilt: false,
          role: "button",
          tabindex: "0",
          "aria-pressed": String(sel === c.id),
          onclick: () => pick(c.id),
          onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick(c.id)),
        }),
      ),
    );
  };
  const pick = (id) => {
    if (sending) return;
    sel = sel === id ? null : id;
    if (sel != null && ta) ta.value = "";
    paintHand(S.v.game.me.hand || []);
    refreshSend();
    audio.unlock();
    vibrate(6);
  };
  const submit = () => {
    if (sending) return;
    const text = ta ? ta.value.trim() : "";
    if (sel == null && !text) {
      toast(mode === "cards" ? "Pick a card first." : "Write something, or play a card.");
      return;
    }
    sending = true;
    refreshSend();
    send({ t: "answer", slot: t.slot, ...(sel != null ? { card: sel } : { text }) });
    if (ta) ta.blur();
    audio.tap();
    vibrate(12);
  };
  sendBtn.onclick = submit;
  if (ta) {
    ta.oninput = () => {
      if (ta.value.includes("\n")) ta.value = ta.value.replace(/\n/g, " ");
      if (ta.value.trim() && sel != null) {
        sel = null;
        paintHand(S.v.game.me.hand || []);
      }
      refreshSend();
    };
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    };
  }
  redrawBtn.onclick = () => {
    if ((S.v.game.me.redraws || 0) <= 0 || sending) return;
    confirmSheet("Swap your whole hand?", "You get one new hand per act.", "New hand", () => {
      sel = null;
      send({ t: "redraw" });
      audio.whoosh();
    });
  };

  const el = h(
    "section",
    { class: `scr write k-${g.kind}` },
    h("div", { class: "w-head" }, g.act ? actPill(g) : null, h("p", { class: "w-label", text: label }), timerBar(g)),
    promptEl(t.prompt),
    ta ? h("div", { class: "card-input-wrap" }, ta, count) : null,
    mode === "mix" ? h("div", { class: "or" }, h("span", { text: "or play a card" })) : null,
    mode !== "write" ? h("div", { class: "hand-head" }, h("span", { class: "mini-h", text: mode === "cards" ? "Pick from your hand" : "Your hand" }), redrawBtn) : null,
    mode !== "write" ? hand : null,
    h("div", { class: "dock" }, sendBtn),
  );

  function update(v2) {
    const me2 = v2.game.me;
    const ids = (me2.hand || []).map((c) => c.id).join(",");
    if (ids !== handIds) {
      handIds = ids;
      if (sel != null && !(me2.hand || []).some((c) => c.id === sel)) sel = null;
      paintHand(me2.hand || []);
    }
    const left = me2.redraws || 0;
    redrawBtn.disabled = left <= 0;
    redrawBtn.querySelector(".rd-t").textContent = left > 0 ? "New hand" : "No swaps left";
    refreshSend();
  }
  update(v);
  return {
    el,
    update,
    nack() {
      sending = false;
      refreshSend();
    },
    mounted() {
      if (ta && mode === "write") setTimeout(() => ta.focus({ preventScroll: true }), 250);
    },
  };
}

function scrWriteWait(v) {
  const g = v.game;
  const me = g.me || {};
  const mine = me.mine || [];
  const isAudience = v.role === "audience";
  const prog = h("div");
  const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
  const el = h(
    "section",
    { class: "scr wait" },
    h("div", { class: "w-head" }, g.act ? actPill(g) : null, timerBar(g)),
    isAudience
      ? h("div", { class: "done-hero" }, h("div", { class: "big-emoji", text: "🍿" }), h("h2", { class: "h2", text: "The comics are writing" }), h("p", { class: "muted", text: "You're in the audience. You'll get to vote in a moment." }))
      : h("div", { class: "done-hero" }, h("div", { class: "check-badge" }, icon("vote")), h("h2", { class: "h2", text: "Locked in" }), h("p", { class: "muted", text: "Nice. Now look innocent." })),
    mine.length ? h("div", { class: "mine" }, mine.map((m) => h("div", { class: "mine-one" }, h("p", { class: "mine-p", text: m.prompt }), cardEl(m.text, { cls: "small" })))) : null,
    prog,
    h("p", { class: "tip" }, h("b", { text: "Tip: " }), tip),
  );
  const update = (v2) => fill(prog, progressRow(v2.game.prog));
  update(v);
  return { el, update };
}

function scrHotJudgeWait(v) {
  const g = v.game;
  const prog = h("div");
  const el = h(
    "section",
    { class: "scr hot-judge" },
    h("div", { class: "w-head" }, actPill(g), timerBar(g)),
    h("div", { class: "seat-hero" }, h("div", { class: "seat-glow" }, avatar(meP(), { size: "xl" })), h("h2", { class: "poster small", text: "You're in the Hot Seat" }), h("p", { class: "muted", text: "Everyone else is writing this one for you. Then you pick a favourite." })),
    promptEl(g.prompt),
    prog,
  );
  if (phoneSfx()) audio.stamp();
  vibrate([30, 40, 30]);
  const update = (v2) => fill(prog, progressRow(v2.game.prog, "Writing for you"));
  update(v);
  return { el, update };
}

function scrVote(v) {
  const g = v.game;
  let mine = g.me.vote;
  const cards = ["a", "b"].map((side, i) =>
    cardEl(g.answers[i], {
      cls: `vcard side-${side}`,
      role: "button",
      tabindex: "0",
      onclick: () => vote(side),
      onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), vote(side)),
    }),
  );
  const foot = h("p", { class: "v-foot" });
  const vote = (side) => {
    const me = S.v.game.me;
    if (!me.canVote || mine) return;
    mine = side;
    send({ t: "vote", side });
    audio.unlock();
    if (phoneSfx()) audio.vote();
    vibrate(15);
    paint(S.v);
  };
  const paint = (v2) => {
    const me = v2.game.me;
    if (me.vote) mine = me.vote;
    cards.forEach((c, i) => {
      const side = i ? "b" : "a";
      c.classList.toggle("yours", me.side === side);
      c.classList.toggle("picked", mine === side);
      c.classList.toggle("dim", !!mine && mine !== side);
      c.classList.toggle("tappable", !!me.canVote && !mine);
      let tag = c.querySelector(".ctag");
      const want = me.side === side ? "yours" : mine === side ? "your vote" : "";
      if (want && !tag) c.append((tag = h("span", { class: "ctag" })));
      if (tag) {
        tag.textContent = want;
        tag.hidden = !want;
      }
    });
    const voted = (v2.game.voted || []).length;
    foot.textContent = me.side
      ? "This one's yours. Sit tight while the room votes."
      : mine
        ? `Vote locked in. ${voted} of ${v2.game.voters} in.`
        : me.canVote
          ? "Tap the funnier answer."
          : "Watching this one.";
  };
  const el = h(
    "section",
    { class: "scr vote" },
    h("div", { class: "w-head" }, actPill(g), h("p", { class: "w-label", text: `Duel ${g.duelNo} of ${g.duelCount}` }), timerBar(g)),
    promptEl(g.prompt),
    h("div", { class: "duel" }, cards[0], h("span", { class: "vs", text: "vs" }), cards[1]),
    foot,
  );
  if (g.me.side) vibrate([25, 50, 25]);
  paint(v);
  return { el, update: paint };
}

function stampEl(text, cls = "") {
  return h("span", { class: `stamp ${cls}`, text });
}

function scrReveal(v) {
  const g = v.game;
  const sides = g.sides.map((s) => {
    const total = g.sides[0].votes.length + g.sides[1].votes.length;
    const card = cardEl(s.text, {
      cls: `rcard${s.win ? " win" : ""}${!s.win && !g.tie ? " lose" : ""}`,
      tag: s.sweep ? stampEl("Killed it!", "kill") : !s.votes.length && total >= 2 ? stampEl("Tough crowd", "tough") : null,
    });
    return h("div", { class: "rside" }, card, h("div", { class: "rmeta" }, whoTag(s.pid, { pts: s.pts, card: s.card, auto: s.auto }), h("div", { class: "rvotes" }, h("b", { text: s.votes.length }), s.votes.length === 1 ? " vote" : " votes", voterRow(s.votes))));
  });
  const me = g.me || {};
  const mineSide = me.side ? g.sides[me.side === "a" ? 0 : 1] : null;
  const el = h(
    "section",
    { class: "scr reveal" },
    h("div", { class: "w-head" }, actPill(g), h("p", { class: "w-label", text: `Duel ${g.duelNo} of ${g.duelCount}` })),
    promptEl(g.prompt),
    h("div", { class: "rgrid" }, sides),
    g.tie ? h("p", { class: "center muted", text: "A dead heat. The points are split." }) : null,
    reactBar(),
  );
  if (mineSide) vibrate(mineSide.win ? [40, 40, 80] : 30);
  if (phoneSfx()) {
    const sweep = g.sides.some((s) => s.sweep);
    setTimeout(() => (sweep ? audio.applause(2) : audio.ding()), 200);
  }
  return { el };
}

function rankList(rows, { you, showDelta = false } = {}) {
  return h(
    "ol",
    { class: "ranks" },
    rows.map((r, i) => {
      const p = P(r.id);
      const delta = showDelta ? r.score - (r.prev || 0) : 0;
      return h(
        "li",
        { class: `rank${r.id === you ? " me" : ""}${r.left ? " gone" : ""}`, style: { "--i": i } },
        h("span", { class: "rank-n", text: r.rank || i + 1 }),
        avatar(p, { size: "s" }),
        h("span", { class: "rank-name", text: p ? p.name : "?" }),
        showDelta && delta ? h("span", { class: "rank-d", text: `+${fmt(delta)}` }) : null,
        h("span", { class: "rank-s", text: fmt(r.score) }),
      );
    }),
  );
}

function scrScores(v) {
  const g = v.game;
  const el = h(
    "section",
    { class: "scr scores" },
    h("div", { class: "w-head" }, actPill(g), timerBar(g, { calm: true })),
    h("h2", { class: "poster small", text: "The leaderboard" }),
    rankList(g.ranking, { you: v.you, showDelta: true }),
    g.nextInfo ? h("p", { class: "next-up" }, "Next up: ", h("b", { text: g.nextInfo.title }), ". ", g.nextInfo.tag, ".") : null,
  );
  if (phoneSfx()) audio.whoosh();
  return { el };
}

function scrHotPick(v) {
  const g = v.game;
  const me = g.me;
  let sel = me.isJudge ? me.pick : me.crowd;
  let sending = false;
  const list = h("div", { class: "alist" });
  const dock = h("div", { class: "dock" });
  const msg = h("p", { class: "v-foot" });

  const choose = (aid) => {
    const m = S.v.game.me;
    if (m.isJudge) {
      if (m.pick != null || sending) return;
      sel = sel === aid ? null : aid;
    } else {
      if (!m.canCrowd || m.crowd != null || aid === m.myAid) return;
      sel = aid;
      send({ t: "crowd", aid });
      if (phoneSfx()) audio.vote();
    }
    vibrate(8);
    paint(S.v);
  };
  const lockPick = () => {
    if (sel == null || sending) return;
    sending = true;
    send({ t: "judge", aid: sel });
    audio.stamp();
    vibrate([20, 30, 60]);
    paint(S.v);
  };
  const cards = g.list.map((a) =>
    cardEl(a.text, {
      cls: "acard",
      role: "button",
      tabindex: "0",
      onclick: () => choose(a.aid),
      onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), choose(a.aid)),
    }),
  );
  list.append(...cards);

  function paint(v2) {
    const g2 = v2.game;
    const m = g2.me;
    if (m.isJudge && m.pick != null) sel = m.pick;
    if (!m.isJudge && m.crowd != null) sel = m.crowd;
    cards.forEach((c, i) => {
      const mineCard = i === m.myAid;
      c.classList.toggle("yours", mineCard);
      c.classList.toggle("picked", sel === i);
      c.classList.toggle("dim", sel != null && sel !== i && (m.isJudge ? m.pick != null : m.crowd != null));
      c.classList.toggle("tappable", m.isJudge ? m.pick == null : m.canCrowd && m.crowd == null && !mineCard);
      let tag = c.querySelector(".ctag");
      const want = mineCard ? "yours" : sel === i ? (m.isJudge ? "your pick" : "your crowd vote") : "";
      if (want && !tag) c.append((tag = h("span", { class: "ctag" })));
      if (tag) {
        tag.textContent = want;
        tag.hidden = !want;
      }
    });
    if (m.isJudge) {
      fill(dock, 
        m.pick != null
          ? h("p", { class: "locked" }, icon("vote"), "Locked in. Next: who wrote it?")
          : h("button", { class: "btn primary big wide", type: "button", disabled: sel == null || sending, onclick: lockPick }, icon("crown"), sel == null ? "Tap your favourite" : "Pick this one"),
      );
      msg.textContent = "";
    } else {
      fill(dock);
      msg.textContent = g2.picked
        ? `${nameOf(g2.judge)} has picked!`
        : m.crowd != null
          ? `Crowd vote in. Let's see if ${nameOf(g2.judge)} agrees.`
          : m.canCrowd
            ? `Tap your favourite to add a crowd vote. ${nameOf(g2.judge)} makes the big call.`
            : `${nameOf(g2.judge)} is choosing.`;
    }
  }
  const el = h(
    "section",
    { class: `scr hot-pick${me.isJudge ? " judge" : ""}` },
    h("div", { class: "w-head" }, actPill(g), h("p", { class: "w-label", text: me.isJudge ? "You're the judge" : `${nameOf(g.judge)} is the judge` }), timerBar(g)),
    promptEl(g.prompt),
    msg,
    list,
    dock,
  );
  if (me.isJudge) vibrate([30, 40, 30]);
  paint(v);
  return { el, update: paint };
}

function scrHotGuess(v) {
  const g = v.game;
  const me = g.me;
  let sent = false;
  const body = h("div", { class: "guess-grid" });
  if (me.isJudge) {
    body.append(
      ...g.candidates.map((id) =>
        h(
          "button",
          {
            class: "guess-btn",
            type: "button",
            onclick: (e) => {
              if (sent) return;
              sent = true;
              e.currentTarget.classList.add("picked");
              send({ t: "guess", id });
              audio.stamp();
              vibrate(20);
            },
          },
          avatar(P(id), { size: "l" }),
          h("span", { text: nameOf(id) }),
        ),
      ),
    );
  } else {
    body.append(...g.candidates.map((id) => h("span", { class: "guess-one" }, avatar(P(id), { size: "m" }), h("span", { text: nameOf(id) }))));
  }
  const el = h(
    "section",
    { class: "scr hot-guess" },
    h("div", { class: "w-head" }, actPill(g), timerBar(g)),
    h("h2", { class: "poster small", text: me.isJudge ? "Who wrote it?" : `${nameOf(g.judge)} is guessing who wrote…` }),
    cardEl(g.chosen.text, { cls: "big picked" }),
    me.mineChosen ? h("p", { class: "notice hot", text: "That's yours! Keep a straight face. 😐" }) : null,
    me.isJudge ? h("p", { class: "muted center", text: "Guess right for +200." }) : null,
    body,
  );
  if (me.mineChosen) vibrate([40, 60, 40, 60, 40]);
  return { el };
}

function scrHotReveal(v) {
  const g = v.game;
  const win = g.list.find((a) => a.aid === g.pick);
  const rest = g.list.filter((a) => a.aid !== g.pick).sort((a, b) => b.pts - a.pts);
  const guessLine = g.asleep
    ? `${nameOf(g.judge)} ran out of time, so the crowd's favourite wins.`
    : g.guess == null
      ? `${nameOf(g.judge)} didn't make a guess.`
      : g.guessRight
        ? `${nameOf(g.judge)} guessed ${nameOf(g.guess)}. Mind reader! +${g.guessPts}`
        : `${nameOf(g.judge)} guessed ${nameOf(g.guess)}, but it was ${nameOf(g.winner)}.`;
  const el = h(
    "section",
    { class: "scr hot-reveal" },
    h("div", { class: "w-head" }, actPill(g), h("p", { class: "w-label", text: `${nameOf(g.judge)}'s pick` })),
    promptEl(g.prompt, { fill: win.text }),
    h("div", { class: "hr-win" }, cardEl(win.text, { cls: "big win", tag: stampEl(g.asleep ? "Crowd pick" : "Judge's pick", "kill") }), whoTag(win.pid, { pts: win.pts, card: win.card, auto: win.auto }), win.crowd.length ? h("div", { class: "rvotes" }, h("b", { text: win.crowd.length }), " crowd", voterRow(win.crowd)) : null),
    h("p", { class: `guess-line${g.guessRight ? " right" : g.guess != null ? " wrong" : ""}`, text: guessLine }),
    rest.length ? h("h3", { class: "mini-h", text: "The rest" }) : null,
    h("div", { class: "rest" }, rest.map((a) => h("div", { class: "rest-one" }, cardEl(a.text, { cls: "small" }), whoTag(a.pid, { pts: a.pts, card: a.card, auto: a.auto }), a.crowd.length ? voterRow(a.crowd) : null))),
    reactBar(),
  );
  if (win.pid === v.you) vibrate([40, 40, 100]);
  if (phoneSfx()) audio.ding(g.guessRight ? 4 : 0);
  return { el };
}

function scrCloserVote(v) {
  const g = v.game;
  let mic = null;
  let tom = null;
  let sending = false;
  const items = g.list.map((a) => {
    const micB = h("button", { class: "vote-chip mic", type: "button", "aria-label": "Give your mic" }, "🎤", h("span", { text: "Mic" }));
    const tomB = h("button", { class: "vote-chip tom", type: "button", "aria-label": "Throw a tomato" }, "🍅");
    micB.onclick = () => {
      if (sending || S.v.game.me.vote) return;
      mic = mic === a.aid ? null : a.aid;
      if (tom === mic) tom = null;
      vibrate(8);
      audio.unlock();
      paint(S.v);
    };
    tomB.onclick = () => {
      if (sending || S.v.game.me.vote) return;
      tom = tom === a.aid ? null : a.aid;
      if (mic === tom) mic = null;
      if (tom != null && phoneSfx()) audio.splat();
      vibrate(14);
      paint(S.v);
    };
    const card = cardEl(a.text, { cls: "ccard" });
    const row = h("div", { class: "citem" }, card, h("div", { class: "cbtns" }, micB, tomB));
    return { a, row, card, micB, tomB };
  });
  const dock = h("div", { class: "dock" });
  const lock = () => {
    if (mic == null || sending) return;
    sending = true;
    send({ t: "closer", mic, tomato: tom });
    audio.stamp();
    vibrate([20, 30, 60]);
    paint(S.v);
  };
  function paint(v2) {
    const m = v2.game.me;
    if (m.vote) {
      mic = m.vote.mic;
      tom = m.vote.tomato;
    }
    const locked = !!m.vote || sending;
    for (const it of items) {
      const mine = it.a.aid === m.myAid;
      it.row.classList.toggle("yours", mine);
      it.row.classList.toggle("has-mic", mic === it.a.aid);
      it.row.classList.toggle("has-tom", tom === it.a.aid);
      it.row.classList.toggle("locked", locked);
      it.micB.hidden = mine || !m.canVote;
      it.tomB.hidden = mine || !m.canVote;
      it.micB.setAttribute("aria-pressed", String(mic === it.a.aid));
      it.tomB.setAttribute("aria-pressed", String(tom === it.a.aid));
      let tag = it.card.querySelector(".ctag");
      if (mine && !tag) it.card.append(h("span", { class: "ctag", text: "yours" }));
    }
    if (!m.canVote) fill(dock, h("p", { class: "locked", text: "Watching the vote." }));
    else if (m.vote) fill(dock, h("p", { class: "locked" }, icon("vote"), `Votes in. ${(v2.game.voted || []).length} of ${v2.game.voters} have voted.`));
    else
      fill(dock, 
        h("button", { class: "btn primary big wide", type: "button", disabled: mic == null || sending, onclick: lock }, "🎤", mic == null ? "Give one answer your mic" : tom == null ? "Lock in my mic" : "Lock in mic + tomato"),
      );
  }
  const el = h(
    "section",
    { class: "scr closer-vote" },
    h("div", { class: "w-head" }, actPill(g), h("p", { class: "w-label", text: "One mic. One optional tomato." }), timerBar(g)),
    promptEl(g.prompt),
    h("div", { class: "clist" }, items.map((it) => it.row)),
    dock,
  );
  paint(v);
  return { el, update: paint };
}

function scrCloserReveal(v) {
  const g = v.game;
  const n = g.order.length;
  const el = h(
    "section",
    { class: "scr closer-reveal" },
    h("div", { class: "w-head" }, actPill(g), h("p", { class: "w-label", text: "Counting up to the winner" })),
    promptEl(g.prompt),
    h(
      "ol",
      { class: "creveal", reversed: true },
      g.order.map((a, i) =>
        h(
          "li",
          { class: `cr-one${a.top ? " top" : ""}`, style: { "--d": `${(i * g.step) / 1000}s` } },
          h("span", { class: "cr-rank", text: `#${n - i}` }),
          cardEl(a.text, { cls: `small${a.top ? " win" : ""}`, tag: a.top ? stampEl("Closer", "kill") : null }),
          h("div", { class: "cr-meta" }, whoTag(a.pid, { pts: a.pts, card: a.card, auto: a.auto }), h("span", { class: "cr-counts" }, `🎤 ${a.mics.length}`, a.tomatoes.length ? `   🍅 ${a.tomatoes.length}` : "")),
        ),
      ),
    ),
    reactBar(),
  );
  // light buzz as each one lands, and a big one for yours
  g.order.forEach((a, i) =>
    setTimeout(() => {
      if (S.key !== "cr") return;
      if (a.pid === v.you) vibrate(a.top ? [50, 40, 120] : 40);
      if (phoneSfx()) a.top ? (audio.fanfare(), audio.applause(2.4)) : audio.ding(i);
    }, i * g.step + 300),
  );
  return { el };
}

function scrFinal(v) {
  const g = v.game;
  const rows = g.ranking;
  const mine = rows.find((r) => r.id === v.you);
  const top3 = rows.slice(0, 3);
  const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean);
  const hostP = P(v.host);
  const actions = h("div", { class: "final-actions" });
  const paintActions = () => {
    fill(actions, 
      isHost()
        ? h("button", { class: "btn primary big wide", type: "button", onclick: () => send({ t: "endGame" }) }, icon("mic"), "Back to the lobby")
        : h("p", { class: "waiting-line" }, `${hostP ? hostP.name : "The host"} can start another show`, h("span", { class: "dots" })),
    );
  };
  const el = h(
    "section",
    { class: "scr final" },
    h("p", { class: "eyebrow center", text: "That's the show!" }),
    mine
      ? h("div", { class: "my-place" }, h("span", { class: "place-n", text: ordinal(mine.rank) }), h("span", { class: "place-s", text: `${fmt(mine.score)} points` }))
      : h("h2", { class: "poster small center", text: "Tonight's headliner" }),
    h(
      "div",
      { class: "podium" },
      podiumOrder.map((r) => {
        const p = P(r.id);
        const place = r.rank;
        return h("div", { class: `pod pod-${top3.indexOf(r) + 1}` }, avatar(p, { size: place === 1 ? "xl" : "l" }), h("span", { class: "pod-name", text: p ? p.name : "?" }), h("span", { class: "pod-score", text: fmt(r.score) }), h("span", { class: "pod-block", text: place }));
      }),
    ),
    g.awards.length ? h("div", { class: "awards" }, g.awards.map((a) => h("div", { class: "award" }, h("span", { class: "award-t", text: a.title }), h("span", { class: "award-who" }, avatar(P(a.pid), { size: "xs" }), nameOf(a.pid)), h("span", { class: "award-d", text: a.desc })))) : null,
    rankList(rows, { you: v.you }),
    actions,
  );
  paintActions();
  if (mine && mine.rank === 1) {
    setTimeout(() => confetti({ count: 120 }), 300);
    vibrate([60, 60, 60, 60, 200]);
  }
  if (phoneSfx()) {
    audio.fanfare();
    audio.applause(3);
  }
  return { el, update: paintActions };
}

// ---------- shell ----------
function renderTop(v) {
  const me = v ? meP() : null;
  const g = v && v.game;
  fill(top, 
    v ? h("button", { class: "code-chip", type: "button", title: "Copy invite link", onclick: () => copyInvite(v.code) }, h("span", { class: "cc-l", text: "Room" }), h("b", { text: v.code })) : h("span"),
    h(
      "div",
      { class: "top-right" },
      v && v.role === "audience" ? h("span", { class: "chip alt", text: "audience" }) : null,
      me ? h("span", { class: "me-chip" }, avatar(me, { size: "s" }), h("span", { class: "me-n", text: me.name }), g && me.score != null ? h("b", { class: "me-s", text: fmt(me.score) }) : null) : null,
      v ? h("button", { class: "icon-btn menu-btn", type: "button", "aria-label": "Menu", onclick: openMenu }, icon("dots")) : null,
    ),
  );
}

async function copyInvite(code) {
  try {
    await navigator.clipboard.writeText(inviteUrl(code));
    toast("Invite link copied");
  } catch {
    toast(inviteUrl(code), { ms: 5000 });
  }
}

function openMenu() {
  const v = S.v;
  if (!v) return;
  const acts = [];
  acts.push([S.sound ? "Sound: on" : "Sound: off", "ghost", () => {
    S.sound = !S.sound;
    st.set("sound", S.sound);
    audio.setMuted(!S.sound);
    toast(S.sound ? "Sound on" : "Sound off");
  }]);
  acts.push(["How to play", "ghost", () => sheet("How it works", howTo(), [["Got it", "primary", null]])]);
  if (isHost() && v.game) acts.push(["End the game", "ghost", () => confirmSheet("End the game?", "Everyone goes back to the lobby. Scores are lost.", "End it", () => send({ t: "endGame" }))]);
  acts.push(["Leave the room", "danger", () => confirmSheet("Leave the room?", v.game ? "Your answers get played for you from your hand until the game ends." : "You can rejoin with the code.", "Leave", () => send({ t: "leave" }))]);
  acts.push(["Close", "ghost", null]);
  sheet(`Room ${v.code}`, h("p", { class: "sheet-p muted", text: `Invite: ${shortHost()}  ·  code ${v.code}` }), acts);
}

function render() {
  const v = S.v;
  let key;
  let make;
  if (!v) {
    if (S.resuming) [key, make] = ["loading", scrLoading];
    else [key, make] = ["home", scrHome];
  } else if (!v.game) [key, make] = ["lobby", scrLobby];
  else {
    const g = v.game;
    const me = g.me || {};
    switch (g.kind) {
      case "intro":
        [key, make] = [`intro:${g.actNo}`, scrIntro];
        break;
      case "write":
      case "hot-write":
      case "closer-write": {
        const t = me.todo && me.todo[0];
        if (t) [key, make] = [`w:${t.slot}`, scrWrite];
        else if (g.kind === "hot-write" && me.isJudge) [key, make] = [`hj:${g.turn}`, scrHotJudgeWait];
        else [key, make] = [`ww:${g.kind}:${g.turn || 0}`, scrWriteWait];
        break;
      }
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
    fill(main, S.scr.el);
    document.body.dataset.screen = key.split(":")[0];
    window.scrollTo(0, 0);
    if (S.scr.mounted) S.scr.mounted();
  } else if (S.scr && S.scr.update) S.scr.update(v);
  renderTop(v);
}

function onMsg(m) {
  switch (m.t) {
    case "joined":
      S.you = m.you;
      S.resuming = false;
      S.busy = false;
      if (m.token) st.set("session", { code: m.code, token: m.token });
      if (S.urlRoom || params.has("room")) {
        S.urlRoom = "";
        const u = new URL(location.href);
        u.searchParams.delete("room");
        history.replaceState(null, "", u.pathname + u.search);
      }
      break;
    case "state":
      S.v = m;
      S.busy = false;
      render();
      break;
    case "resumeFail":
      st.del("session");
      S.resuming = false;
      S.v = null;
      render();
      break;
    case "error":
      S.busy = false;
      toast(m.msg || "Something went wrong.");
      if (m.code === "noroom" && !S.v) {
        S.urlRoom = "";
      }
      render();
      break;
    case "nack":
      toast("That didn't go through. Try again.");
      if (S.scr && S.scr.nack) S.scr.nack(m.what);
      break;
    case "kicked":
      st.del("session");
      S.v = null;
      S.notice = "The host removed you from the room.";
      render();
      break;
    case "left":
      st.del("session");
      S.v = null;
      S.key = null;
      render();
      break;
    case "gone":
      st.del("session");
      S.v = null;
      S.notice = "That room has closed. Start a new one?";
      render();
      break;
    case "react":
      if (S.v && !S.v.tv && m.id !== S.v.you) floatReact(m.e);
      break;
  }
}

export function startPhone() {
  installWall();
  document.body.classList.add("phone");
  const app = document.getElementById("app");
  top = h("header", { class: "p-top" });
  main = h("main", { class: "p-main", id: "main" });
  fill(app, h("div", { class: "wall", "aria-hidden": "true" }), top, main);
  audio.setMuted(!S.sound);
  net = new Net({
    onMsg,
    onOpen() {
      const sess = st.get("session");
      if (sess && sess.code && (!S.urlRoom || S.urlRoom === sess.code)) {
        S.resuming = true;
        net.send({ t: "resume", code: sess.code, token: sess.token });
      }
      document.body.classList.remove("offline");
      render();
    },
    onClose() {
      document.body.classList.add("offline");
    },
  });
  setClock(() => net.serverNow());
  if (st.get("session") && (!S.urlRoom || S.urlRoom === st.get("session").code)) S.resuming = true;
  net.connect();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) net.kick();
  });
  window.addEventListener("pointerdown", () => audio.unlock(), { passive: true });
  render();
  if (DEV) window.__tc = { S, net, render };
}
