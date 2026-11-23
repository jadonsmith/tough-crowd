/*
 * Tough Crowd: static file server + WebSocket party-game server in one Node process.
 *
 * A room has a 4-letter code. Phones join as players (3 to 10) or, once a game
 * is running or the room is full, as the audience. Any number of big screens
 * (?tv) can show the room. All the rules live in game/engine.js; this file
 * keeps rooms, sockets, reconnects and the clock, and sends every client its own
 * view of the game whenever something changes.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WebSocketServer, WebSocket } from "ws";
import { Game, CardDeck, PromptPool } from "./game/engine.js";
import { BOT_LINES } from "./game/content.js";
import { cleanName } from "./game/filter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PORT = Number(process.env.PORT) || 3160;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const QR_JS = require.resolve("qrcode-generator/qrcode.js");

// TIME_SCALE < 1 speeds every phase up; only the headless tests set it.
const TS = Math.min(1, Math.max(0.01, Number(process.env.TIME_SCALE) || 1));
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const MAX_AUDIENCE = 24;
const MAX_DISPLAYS = 4;
const MAX_ROOMS = 400;
const ABSENT_MS = 15000; // gone this long and we stop waiting on them mid-phase
const HOST_HANDOFF_MS = 20000;
const LOBBY_DROP_MS = 90000;
const EMPTY_LOBBY_MS = 5 * 60000;
const EMPTY_GAME_MS = 15 * 60000;
const TICK_MS = 200;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export const EMOJIS = ["😎", "🤡", "🐸", "🦊", "🐙", "👽", "🤠", "🧛", "🦄", "🐔", "🌮", "🥔", "🐧", "🦖", "👻", "🤖", "🐵", "🦉", "🍕", "🧀", "🦝", "🐌", "🦩", "🎩"];
const COLORS = ["#ff4fa3", "#ffc23d", "#2fe3c8", "#9b7bff", "#ff7a45", "#5cc8ff", "#b6f05a", "#ff5d6c", "#f78bff", "#ffe08a"];
const BOT_NAMES = ["Botley", "Chuckles", "Unit 7", "Gigglebyte", "Rusty", "Clank", "Beep", "Sir Circuit", "Sprocket", "Widget"];
const REACTIONS = new Set(["lol", "clap", "fire", "tomato", "dead"]);

// ---------- static files ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob: data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

function sendFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const mtime = st.mtime.toUTCString();
    const headers = {
      "Last-Modified": mtime,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    };
    if (filePath.endsWith(".html")) headers["Content-Security-Policy"] = CSP;
    if (req.headers["if-modified-since"] === mtime) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, {
      ...headers,
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Content-Length": st.size,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  if (urlPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`ok ${rooms.size} rooms\n`);
    return;
  }
  if (urlPath === "/vendor/qrcode.js") return sendFile(req, res, QR_JS);
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  sendFile(req, res, filePath);
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, maxPayload: 4096 });

// ---------- helpers ----------
function sendRaw(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1 << 20) ws.send(data);
}
function send(ws, msg) {
  sendRaw(ws, JSON.stringify(msg));
}
function randomCode() {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}
const newId = () => crypto.randomBytes(6).toString("base64url");
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// ---------- rooms ----------
const rooms = new Map(); // code -> room

function defaultSettings() {
  return { acts: { h2h: true, hot: true, closer: true }, answers: "mix", pace: "normal", family: false };
}

function cleanSettings(s, prev) {
  if (!s || typeof s !== "object") return prev;
  const a = s.acts && typeof s.acts === "object" ? s.acts : prev.acts;
  const acts = { h2h: !!a.h2h, hot: !!a.hot, closer: !!a.closer };
  return {
    acts: acts.h2h || acts.hot || acts.closer ? acts : prev.acts,
    answers: ["mix", "cards", "write"].includes(s.answers) ? s.answers : prev.answers,
    pace: ["relaxed", "normal", "quick"].includes(s.pace) ? s.pace : prev.pace,
    family: typeof s.family === "boolean" ? s.family : prev.family,
  };
}

function makeRoom(now) {
  if (rooms.size >= MAX_ROOMS) return null;
  let code;
  do code = randomCode();
  while (rooms.has(code));
  const room = {
    code,
    players: new Map(), // id -> member (players and audience, in join order)
    displays: new Set(),
    hostId: null,
    settings: defaultSettings(),
    game: null,
    deck: new CardDeck(),
    prompts: new PromptPool(),
    lastActive: now,
    dirty: false,
    botTimers: [],
    botPhase: null,
    games: 0,
    last: null, // summary of the previous game, shown in the lobby
  };
  room.presence = {
    present(id, t) {
      const p = room.players.get(id);
      if (!p || p.left) return false;
      return p.bot || p.connected || t - p.lastSeen < ABSENT_MS;
    },
    audience() {
      const out = [];
      for (const p of room.players.values()) if (p.role === "audience" && p.connected) out.push(p.id);
      return out;
    },
    isAudience(id) {
      const p = room.players.get(id);
      return !!p && p.role === "audience";
    },
  };
  rooms.set(code, room);
  return room;
}

function deleteRoom(room) {
  clearBots(room);
  if (room.game) room.game.returnCards();
  for (const p of room.players.values()) if (p.ws) send(p.ws, { t: "gone" });
  for (const ws of room.displays) send(ws, { t: "gone" });
  rooms.delete(room.code);
}

function members(room) {
  return [...room.players.values()];
}
function seated(room) {
  return members(room).filter((p) => p.role === "player" && !p.left);
}

function uniqueName(room, name, selfId = null) {
  const taken = new Set(members(room).filter((p) => p.id !== selfId && !p.left).map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 99; i++) {
    const base = [...name].slice(0, 12 - String(i).length - 1).join("");
    const cand = `${base} ${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return name;
}
function pickEmoji(room, want, selfId = null) {
  const taken = new Set(members(room).filter((p) => p.id !== selfId && !p.left).map((p) => p.emoji));
  if (EMOJIS.includes(want) && !taken.has(want)) return want;
  const free = EMOJIS.filter((e) => !taken.has(e));
  return free.length ? free[Math.floor(Math.random() * free.length)] : EMOJIS[0];
}
function pickColor(room) {
  const taken = new Set(members(room).filter((p) => !p.left).map((p) => p.color));
  return COLORS.find((c) => !taken.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
}

function pickHost(room, notId = null) {
  const cands = seated(room).filter((p) => !p.bot && p.id !== notId);
  return (cands.find((p) => p.connected) || null)?.id ?? null;
}

function addMember(room, ws, { name, emoji }, now, { bot = false } = {}) {
  const live = members(room).filter((p) => !p.left);
  const nSeated = live.filter((p) => p.role === "player").length;
  const role = room.game || nSeated >= MAX_PLAYERS ? "audience" : "player";
  if (role === "audience" && live.filter((p) => p.role === "audience").length >= MAX_AUDIENCE) return null;
  const p = {
    id: newId(),
    token: crypto.randomBytes(16).toString("hex"),
    name: uniqueName(room, name),
    emoji: pickEmoji(room, emoji),
    color: pickColor(room),
    ws: bot ? null : ws,
    connected: true,
    lastSeen: now,
    role,
    bot,
    left: false,
  };
  room.players.set(p.id, p);
  if (!bot && role === "player" && (!room.hostId || !room.players.get(room.hostId)?.connected)) room.hostId = p.id;
  return p;
}

function attachPlayer(ws, room, p) {
  ws.meta = { code: room.code, pid: p.id, display: false };
  send(ws, { t: "joined", code: room.code, you: p.id, token: p.token, role: p.role });
  dirty(room);
}

function attachDisplay(ws, room) {
  room.displays.add(ws);
  ws.meta = { code: room.code, pid: null, display: true };
  send(ws, { t: "joined", code: room.code, you: null, role: "display" });
  dirty(room);
}

function detach(ws) {
  const m = ws.meta;
  ws.meta = null;
  if (!m) return;
  const room = rooms.get(m.code);
  if (!room) return;
  if (m.display) room.displays.delete(ws);
  else {
    const p = room.players.get(m.pid);
    if (p && p.ws === ws) {
      p.ws = null;
      p.connected = false;
      p.lastSeen = Date.now();
    }
  }
  dirty(room);
}

// Leaving for good (the Leave button, or kicked by the host).
function removeMember(room, p, now) {
  if (room.game && room.game.byId.has(p.id)) {
    p.left = true;
    p.connected = false;
    p.ws = null;
    room.game.markLeft(p.id, now);
  } else {
    room.players.delete(p.id);
  }
  if (room.hostId === p.id) room.hostId = pickHost(room, p.id);
  dirty(room);
}

function startGame(room, now) {
  const seats = seated(room);
  if (seats.length < MIN_PLAYERS) return false;
  room.games++;
  room.game = new Game({
    players: seats.map((p) => ({ id: p.id, name: p.name })),
    settings: room.settings,
    deck: room.deck,
    prompts: room.prompts,
    presence: room.presence,
    timeScale: TS,
    now,
  });
  room.botPhase = null;
  return true;
}

function toLobby(room) {
  const g = room.game;
  if (g) {
    if (g.phase.kind === "final") {
      const top = g.final.ranking[0];
      const p = top && room.players.get(top.id);
      room.last = p ? { name: p.name, emoji: p.emoji, score: top.score } : null;
    }
    g.returnCards();
  }
  room.game = null;
  clearBots(room);
  for (const p of members(room)) if (p.left) room.players.delete(p.id);
  let n = seated(room).length;
  for (const p of members(room)) {
    if (p.role === "audience" && n < MAX_PLAYERS) {
      p.role = "player";
      n++;
    }
  }
  if (!room.hostId || !room.players.get(room.hostId)) room.hostId = pickHost(room);
  dirty(room);
}

// ---------- views ----------
function pub(p, g) {
  return {
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    color: p.color,
    on: p.bot || p.connected,
    bot: p.bot,
    left: p.left,
    score: g && g.scores.has(p.id) ? g.scores.get(p.id) : null,
  };
}

function viewFor(room, p, now) {
  const g = room.game;
  const all = members(room);
  return {
    t: "state",
    code: room.code,
    you: p ? p.id : null,
    role: p ? p.role : "display",
    host: room.hostId,
    tv: room.displays.size > 0,
    settings: room.settings,
    min: MIN_PLAYERS,
    max: MAX_PLAYERS,
    players: all.filter((x) => x.role === "player").map((x) => pub(x, g)),
    audience: all.filter((x) => x.role === "audience").map((x) => pub(x, g)),
    game: g ? g.view(p ? p.id : null, now) : null,
    last: room.last,
    games: room.games,
  };
}

function dirty(room) {
  if (room.dirty) return;
  room.dirty = true;
  setImmediate(() => flush(room));
}

function flush(room) {
  room.dirty = false;
  if (rooms.get(room.code) !== room) return;
  const now = Date.now();
  for (const p of room.players.values()) if (p.ws && p.connected) send(p.ws, viewFor(room, p, now));
  if (room.displays.size) {
    const data = JSON.stringify(viewFor(room, null, now));
    for (const ws of room.displays) sendRaw(ws, data);
  }
  planBots(room);
}

// ---------- bots (for testing alone: ?dev in the lobby) ----------
function clearBots(room) {
  for (const t of room.botTimers) clearTimeout(t);
  room.botTimers = [];
}

function planBots(room) {
  const g = room.game;
  if (!g || room.botPhase === g.phase) return;
  room.botPhase = g.phase;
  clearBots(room);
  const ph = g.phase;
  const later = (ms, fn) => {
    room.botTimers.push(
      setTimeout(() => {
        if (room.game !== g || g.phase !== ph) return;
        if (fn(Date.now())) dirty(room);
      }, ms * TS),
    );
  };
  for (const p of room.players.values()) {
    if (!p.bot || p.left) continue;
    const id = p.id;
    const v = g.view(id, Date.now());
    const me = v.me;
    const answerFor = () => {
      const hand = g.hand(id);
      const canCard = g.mode !== "write" && hand.length;
      if (canCard && (g.mode === "cards" || Math.random() < 0.7)) return { card: hand[Math.floor(Math.random() * hand.length)] };
      return { text: BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)] };
    };
    switch (ph.kind) {
      case "write":
      case "hot-write":
      case "closer-write":
        (me.todo || []).forEach((t, i) => later(rand(2500, 9000) + i * 3000, (now) => g.answer(id, t.slot, answerFor(), now)));
        break;
      case "vote":
        if (me.canVote) later(rand(1500, 6000), (now) => g.vote(id, Math.random() < 0.5 ? "a" : "b", now));
        break;
      case "hot-pick":
        if (me.isJudge) later(rand(3500, 9000), (now) => g.hotPick(id, Math.floor(Math.random() * v.list.length), now));
        else if (me.canCrowd) {
          const opts = v.list.map((x) => x.aid).filter((aid) => aid !== me.myAid);
          if (opts.length) later(rand(1500, 5000), (now) => g.hotCrowd(id, opts[Math.floor(Math.random() * opts.length)], now));
        }
        break;
      case "hot-guess":
        if (me.isJudge) {
          const c = v.candidates;
          later(rand(2000, 5000), (now) => g.hotGuess(id, c[Math.floor(Math.random() * c.length)], now));
        }
        break;
      case "closer-vote":
        if (me.canVote) {
          const opts = v.list.map((x) => x.aid).filter((aid) => aid !== me.myAid);
          if (opts.length) {
            const mic = opts[Math.floor(Math.random() * opts.length)];
            const rest = opts.filter((a) => a !== mic);
            const tomato = rest.length && Math.random() < 0.4 ? rest[Math.floor(Math.random() * rest.length)] : null;
            later(rand(2500, 8000), (now) => g.closerVote(id, mic, tomato, now));
          }
        }
        break;
    }
  }
}

// ---------- messages ----------
function onMessage(ws, msg) {
  const now = Date.now();
  if (msg.t === "ping") return send(ws, { t: "pong", c: msg.c, s: now });

  // --- getting into a room ---
  if (msg.t === "create" || msg.t === "createTv" || msg.t === "join" || msg.t === "watch" || msg.t === "resume") {
    detach(ws);
    if (msg.t === "create" || msg.t === "join") {
      const name = cleanName(msg.name);
      if (!name) return send(ws, { t: "error", code: "name", msg: "Pick a name first." });
      let room;
      if (msg.t === "create") {
        room = makeRoom(now);
        if (!room) return send(ws, { t: "error", code: "full", msg: "The club is packed. Try again in a minute." });
      } else {
        room = rooms.get(String(msg.code || "").toUpperCase());
        if (!room) return send(ws, { t: "error", code: "noroom", msg: "No room with that code." });
      }
      const p = addMember(room, ws, { name, emoji: msg.emoji }, now);
      if (!p) return send(ws, { t: "error", code: "full", msg: "That room is full." });
      room.lastActive = now;
      return attachPlayer(ws, room, p);
    }
    if (msg.t === "createTv" || msg.t === "watch") {
      const room = msg.t === "createTv" ? makeRoom(now) : rooms.get(String(msg.code || "").toUpperCase());
      if (!room) return send(ws, { t: "error", code: "noroom", msg: msg.t === "watch" ? "No room with that code." : "The club is packed. Try again in a minute." });
      if (room.displays.size >= MAX_DISPLAYS) return send(ws, { t: "error", code: "full", msg: "That room already has enough big screens." });
      room.lastActive = now;
      return attachDisplay(ws, room);
    }
    // resume
    const room = rooms.get(String(msg.code || "").toUpperCase());
    const p = room && typeof msg.token === "string" ? members(room).find((x) => x.token === msg.token && !x.left && !x.bot) : null;
    if (!p) return send(ws, { t: "resumeFail" });
    if (p.ws && p.ws !== ws) {
      const old = p.ws;
      old.meta = null;
      try {
        old.close(4000, "replaced");
      } catch {}
    }
    p.ws = ws;
    p.connected = true;
    p.lastSeen = now;
    if (!room.hostId && p.role === "player") room.hostId = p.id;
    room.lastActive = now;
    return attachPlayer(ws, room, p);
  }

  const m = ws.meta;
  if (!m) return;
  const room = rooms.get(m.code);
  if (!room) return;
  if (m.display) return; // big screens only watch
  const p = room.players.get(m.pid);
  if (!p || p.ws !== ws) return;
  p.lastSeen = now;
  const g = room.game;
  const isHost = room.hostId === p.id;
  let ok = false;

  switch (msg.t) {
    case "leave":
      ws.meta = null;
      removeMember(room, p, now);
      return send(ws, { t: "left" });
    case "emoji":
      p.emoji = pickEmoji(room, msg.emoji, p.id);
      ok = true;
      break;
    case "rename":
      if (!g) {
        const name = cleanName(msg.name);
        if (name) {
          p.name = uniqueName(room, name, p.id);
          ok = true;
        }
      }
      break;
    case "settings":
      if (isHost && !g) {
        room.settings = cleanSettings(msg.settings, room.settings);
        ok = true;
      }
      break;
    case "start":
      if (isHost && !g) {
        ok = startGame(room, now);
        if (!ok) send(ws, { t: "error", code: "start", msg: `You need at least ${MIN_PLAYERS} players.` });
      }
      break;
    case "kick": {
      const q = room.players.get(msg.id);
      if (isHost && q && q.id !== p.id) {
        if (q.ws) {
          send(q.ws, { t: "kicked" });
          q.ws.meta = null;
        }
        removeMember(room, q, now);
        ok = true;
      }
      break;
    }
    case "addBot":
      if (isHost && !g && seated(room).length < MAX_PLAYERS) {
        const used = new Set(members(room).map((x) => x.name));
        const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${room.players.size}`;
        ok = !!addMember(room, null, { name, emoji: "🤖" }, now, { bot: true });
      }
      break;
    case "endGame":
      if (isHost && g) {
        toLobby(room);
        ok = true;
      }
      break;
    case "react":
      if (REACTIONS.has(msg.e) && now - (p.lastReact || 0) > 300) {
        p.lastReact = now;
        const data = JSON.stringify({ t: "react", e: msg.e, id: p.id });
        for (const d of room.displays) sendRaw(d, data);
        for (const q of room.players.values()) if (q.ws && q !== p) sendRaw(q.ws, data);
      }
      return;
    default:
      if (!g) return;
      switch (msg.t) {
        case "answer":
          ok = g.answer(p.id, String(msg.slot), { text: typeof msg.text === "string" ? msg.text : undefined, card: Number.isInteger(msg.card) ? msg.card : undefined }, now);
          if (!ok) send(ws, { t: "nack", what: "answer" });
          break;
        case "redraw":
          ok = g.redraw(p.id, now);
          break;
        case "vote":
          ok = g.vote(p.id, msg.side, now);
          break;
        case "judge":
          ok = g.hotPick(p.id, msg.aid, now);
          break;
        case "crowd":
          ok = g.hotCrowd(p.id, msg.aid, now);
          break;
        case "guess":
          ok = g.hotGuess(p.id, msg.id, now);
          break;
        case "closer":
          ok = g.closerVote(p.id, msg.mic, Number.isInteger(msg.tomato) ? msg.tomato : null, now);
          if (!ok) send(ws, { t: "nack", what: "closer" });
          break;
      }
  }
  if (ok) dirty(room);
}

wss.on("connection", (ws) => {
  ws.meta = null;
  ws.bucket = { n: 40, at: Date.now() };
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const now = Date.now();
    const b = ws.bucket;
    b.n = Math.min(40, b.n + ((now - b.at) / 1000) * 15);
    b.at = now;
    if (b.n < 1) return;
    b.n -= 1;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
    try {
      onMessage(ws, msg);
    } catch (e) {
      console.error("message error", msg.t, e);
    }
  });
  ws.on("close", () => detach(ws));
  ws.on("error", () => {});
});

// ---------- clock ----------
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    try {
      if (room.game && room.game.tick(now)) dirty(room);
      if (!room.game) {
        for (const p of members(room)) {
          if (!p.bot && !p.connected && now - p.lastSeen > LOBBY_DROP_MS) {
            room.players.delete(p.id);
            if (room.hostId === p.id) room.hostId = pickHost(room, p.id);
            dirty(room);
          }
        }
      }
      const host = room.players.get(room.hostId);
      if (!host || host.left || (!host.connected && now - host.lastSeen > HOST_HANDOFF_MS)) {
        const next = pickHost(room, host?.id);
        if (next && next !== room.hostId) {
          room.hostId = next;
          dirty(room);
        }
      }
      const anyone = room.displays.size > 0 || members(room).some((p) => !p.bot && p.connected);
      if (anyone) room.lastActive = now;
      else if (now - room.lastActive > (room.game ? EMPTY_GAME_MS : EMPTY_LOBBY_MS)) deleteRoom(room);
    } catch (e) {
      console.error("tick error", room.code, e);
    }
  }
}, TICK_MS);

// Drop sockets that stopped answering pings (phones that died mid-game).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 20000);

server.listen(PORT, HOST, () => {
  console.log(`Tough Crowd on http://localhost:${PORT}${TS < 1 ? ` (time x${TS})` : ""}`);
});
