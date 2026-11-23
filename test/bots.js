// Fill a real room with scripted phones, for testing on your own.
//   node test/bots.js CODE [count] [ws-url]
//   node test/bots.js ABCD 4                      (local server on :3160)
//   node test/bots.js ABCD 3 wss://play.jadon.me/crowd/
import { BotClient } from "./botclient.js";

const [code, count = "3", url = "ws://localhost:3160/"] = process.argv.slice(2);
if (!code) {
  console.log("usage: node test/bots.js CODE [count] [ws-url]");
  process.exit(1);
}
const NAMES = ["Biscuit", "Nugget", "Pickles", "Waffles", "Noodle", "Gizmo", "Sprout", "Pudding", "Doodle"];
const EMOJI = ["🐸", "🦊", "🐙", "🦄", "🐧", "🦖", "🦝", "🐌", "🦩"];
const bots = [];
for (let i = 0; i < Number(count); i++) {
  const b = new BotClient({ url, name: NAMES[i % NAMES.length], emoji: EMOJI[i % EMOJI.length], code: code.toUpperCase(), speed: 6 });
  try {
    await b.open();
    bots.push(b);
    console.log(`joined as ${b.name} (${b.joined.role})`);
  } catch (e) {
    console.log(`couldn't join: ${e.message}`);
  }
}
console.log(`${bots.length} bots playing in ${code.toUpperCase()}. Ctrl+C to stop.`);
