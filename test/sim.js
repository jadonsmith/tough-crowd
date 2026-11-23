// Headless end-to-end: boots the real server at high speed, fills rooms with
// scripted phones and a big screen, and plays whole shows over WebSockets.
// Run: node test/sim.js

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { BotClient } from "./botclient.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 39160;
const URL = `ws://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", TIME_SCALE: "0.03" }, stdio: ["ignore", "pipe", "pipe"] });
let serverErr = "";
server.stderr.on("data", (d) => (serverErr += d));
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("Tough Crowd on") && resolve());
  server.on("exit", (c) => reject(new Error(`server exited ${c}: ${serverErr}`)));
  setTimeout(() => reject(new Error("server didn't start")), 8000);
});

function display(code = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const d = { ws, v: null, states: 0, reacts: 0, code: null };
    ws.on("open", () => ws.send(JSON.stringify(code ? { t: "watch", code } : { t: "createTv" })));
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.t === "joined") {
        d.code = m.code;
        resolve(d);
      } else if (m.t === "state") {
        d.v = m;
        d.states++;
        // a big screen must never see who wrote what before a reveal
        const g = m.game;
        if (g && (g.kind === "hot-pick" || g.kind === "closer-vote")) for (const a of g.list) assert.deepEqual(Object.keys(a).sort(), ["aid", "text"]);
        if (g && g.kind === "vote") assert.ok(g.answers.every((a) => typeof a === "string"));
      } else if (m.t === "react") d.reacts++;
      else if (m.t === "error") reject(new Error(m.msg));
    });
  });
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function playShow({ n, settings = null, dropOne = false, label }) {
  const tv = await display();
  const host = await new BotClient({ url: URL, name: "Host", code: tv.code, speed: 0.4 }).open();
  const bots = [host];
  for (let i = 1; i < n; i++) bots.push(await new BotClient({ url: URL, name: `Bot ${i}`, code: tv.code, speed: 0.4 }).open());
  await waitFor(() => host.v && host.v.players.length === n, 3000, "everyone in the lobby");
  assert.equal(host.v.host, host.you, "first phone into a TV-made room is the host");
  assert.ok(host.v.tv, "phones know a big screen is connected");
  if (settings) host.send({ t: "settings", settings: { ...host.v.settings, ...settings } });
  await sleep(50);
  // a non-host can't start the game
  bots[1].send({ t: "start" });
  await sleep(80);
  assert.equal(host.v.game, null, "non-host start ignored");
  host.send({ t: "start" });
  await waitFor(() => host.v.game, 3000, "game start");
  // a late joiner becomes audience
  const late = await new BotClient({ url: URL, name: "Late", code: tv.code, speed: 0.4 }).open();
  assert.equal(late.joined.role, "audience");
  let dropped = null;
  if (dropOne) {
    await waitFor(() => host.v.game && host.v.game.kind === "vote", 8000, "first vote");
    dropped = bots[2];
    dropped.drop();
    await sleep(300);
    await dropped.open(true); // resume with the saved token
    assert.equal(dropped.joined.you, dropped.you, "resume gets the same seat back");
  }
  await waitFor(() => host.v.game && host.v.game.kind === "final", 60000, `${label}: final`);
  const fin = host.v.game;
  assert.equal(fin.ranking.length, n);
  for (const b of bots) await waitFor(() => b.v.game && b.v.game.kind === "final", 3000, "all phones at final");
  // back to the lobby: the late joiner gets a seat
  host.send({ t: "endGame" });
  await waitFor(() => !host.v.game, 3000, "lobby again");
  if (n < 10) assert.ok(host.v.players.some((p) => p.name === "Late"), "audience promoted to a seat");
  assert.ok(host.v.last, "lobby remembers the last headliner");
  assert.ok(tv.states > 20, "big screen got states");
  const out = { label, n, states: host.states, tvStates: tv.states, reacts: tv.reacts, top: fin.ranking[0].score, awards: fin.awards.map((a) => a.id).join(",") };
  for (const b of [...bots, late]) b.ws.close();
  tv.ws.close();
  return out;
}

const results = [];
try {
  results.push(await playShow({ n: 3, label: "3 players, full show" }));
  results.push(await playShow({ n: 6, label: "6 players, drop + resume", dropOne: true }));
  results.push(await playShow({ n: 10, label: "10 players, cards only, quick", settings: { answers: "cards", pace: "quick" } }));
  results.push(await playShow({ n: 4, label: "4 players, write only, no hot seat", settings: { answers: "write", acts: { h2h: true, hot: false, closer: true } } }));
  results.push(await playShow({ n: 5, label: "5 players, hot seat only", settings: { acts: { h2h: false, hot: true, closer: false } } }));

  // phone-made room, kick, leave, bad input
  const a = await new BotClient({ url: URL, name: "Ann", create: true }).open();
  const b = await new BotClient({ url: URL, name: "Ann", code: a.code }).open();
  await waitFor(() => b.v && b.v.players.length === 2, 2000, "b in");
  assert.ok(b.v.players.some((p) => p.name === "Ann 2"), "duplicate names get a number");
  a.send({ t: "start" });
  await sleep(100);
  assert.equal(a.v.game, null, "can't start with two players");
  a.send({ t: "kick", id: b.you });
  await waitFor(() => a.v.players.length === 1, 2000, "kick");
  a.send({ t: "answer", slot: "m0", text: "x".repeat(5000) }); // oversize payload is dropped by ws, not a crash
  await sleep(100);
  const bad = new WebSocket(URL);
  await new Promise((r) => bad.on("open", r));
  bad.send("not json");
  bad.send(JSON.stringify({ t: "join", code: "ZZZZ", name: "x" }));
  bad.send(JSON.stringify({ t: "vote", side: "a" }));
  await sleep(100);
  bad.close();
  a.ws.close();
  b.ws.close();

  console.table(results);
  assert.ok(!/error/i.test(serverErr), `server stderr: ${serverErr}`);
  console.log("sim: all shows finished ✔");
} catch (e) {
  console.error(e);
  console.error("server stderr:", serverErr);
  process.exitCode = 1;
} finally {
  server.kill();
}
