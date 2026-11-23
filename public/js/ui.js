// Small DOM helpers shared by the phone and the big screen.
// User text only ever goes in through textContent.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "style") {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv == null) continue;
          if (sk.startsWith("--")) el.style.setProperty(sk, sv);
          else el.style[sk] = sv;
        }
      } else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "svg") el.innerHTML = v; // static icons written in this file only
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// replaceChildren, minus the null/false holes that conditional children leave.
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

export const fmt = (n) => (n ?? 0).toLocaleString("en-US");
export const ROMAN = ["", "I", "II", "III", "IV"];
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function hash(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}
export const tiltFor = (s, amt = 1.6) => (((hash(s) % 1000) / 1000) * 2 - 1) * amt;

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------- storage (never trusted, never required) ----------
export function store(ns = "") {
  const k = (key) => `tc:${ns ? ns + ":" : ""}${key}`;
  return {
    get(key) {
      try {
        const v = localStorage.getItem(k(key));
        return v == null ? null : JSON.parse(v);
      } catch {
        return null;
      }
    },
    set(key, val) {
      try {
        localStorage.setItem(k(key), JSON.stringify(val));
      } catch {}
    },
    del(key) {
      try {
        localStorage.removeItem(k(key));
      } catch {}
    },
  };
}

// ---------- clock + timers ----------
let clock = () => Date.now();
export function setClock(fn) {
  clock = fn;
}
export const now = () => clock();

const tickers = new Set();
export function onTick(fn) {
  tickers.add(fn);
  return () => tickers.delete(fn);
}
setInterval(() => {
  const t = clock();
  for (const el of document.querySelectorAll("[data-ends]")) {
    const ends = Number(el.dataset.ends);
    const dur = Number(el.dataset.dur) || 1;
    const left = Math.max(0, ends - t);
    el.style.setProperty("--f", clamp(left / dur, 0, 1).toFixed(4));
    const s = Math.ceil(left / 1000);
    const num = el.querySelector(".t-num");
    if (num && num.textContent !== String(s)) num.textContent = s;
    el.classList.toggle("low", left < 10000 && left > 0);
    el.classList.toggle("done", left <= 0);
  }
  for (const fn of tickers) fn(t);
}, 100);

export function timerBar(g, { calm = false } = {}) {
  if (!g || g.endsAt == null) return h("div", { class: "tbar idle" });
  return h(
    "div",
    { class: `tbar${calm ? " calm" : ""}`, dataset: { ends: g.endsAt, dur: g.dur } },
    h("span", { class: "tbar-track" }, h("span", { class: "tbar-fill" })),
    h("span", { class: "t-num" }),
  );
}

export function timerRing(g, { size = 88 } = {}) {
  if (!g || g.endsAt == null) return h("div", { class: "tring idle" });
  const r = 42;
  const c = 2 * Math.PI * r;
  return h(
    "div",
    { class: "tring", style: { "--c": c.toFixed(2), width: size + "px", height: size + "px" }, dataset: { ends: g.endsAt, dur: g.dur } },
    h("span", {
      class: "tring-svg",
      svg: `<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="tr-bg" cx="50" cy="50" r="${r}"/><circle class="tr-fg" cx="50" cy="50" r="${r}"/></svg>`,
    }),
    h("span", { class: "t-num" }),
  );
}

// ---------- pieces ----------
export function avatar(p, { size = "m", label = false, cls = "", style = null } = {}) {
  const el = h(
    "span",
    {
      class: `av av-${size}${p && p.on === false ? " off" : ""}${p && p.left ? " gone" : ""} ${cls}`,
      style: { "--c": (p && p.color) || "#8a7f78", ...(style || {}) },
      title: p ? p.name : "",
    },
    h("span", { class: "av-e", text: (p && p.emoji) || "?" }),
  );
  if (!label) return el;
  return h("span", { class: `avl avl-${size} ${cls}` }, el, h("span", { class: "avl-n", text: p ? p.name : "?" }));
}

export function promptEl(text, { cls = "", fill = null } = {}) {
  const t = h("p", { class: "board-t" });
  const parts = String(text || "").split("____");
  parts.forEach((part, i) => {
    t.append(part);
    if (i < parts.length - 1) t.append(fill ? h("span", { class: "blank filled", text: fill }) : h("span", { class: "blank" }));
  });
  const len = String(text || "").length;
  return h("div", { class: `board ${len > 70 ? "long" : len > 44 ? "mid" : "short"} ${cls}` }, t);
}

export function cardEl(text, { cls = "", tilt = true, tag = null, style = null, ...rest } = {}) {
  const len = String(text || "").length;
  return h(
    "div",
    { class: `card ${len > 48 ? "long" : len > 26 ? "mid" : "short"} ${cls}`, style: { "--tilt": (tilt ? tiltFor(String(text)) : 0).toFixed(2) + "deg", ...(style || {}) }, ...rest },
    h("p", { class: "card-t", text }),
    tag,
  );
}

let toastTimer = null;
export function toast(msg, { ms = 2600 } = {}) {
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" });
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), ms);
}

export function logoEl(cls = "") {
  return h(
    "h1",
    { class: `logo ${cls}`, "aria-label": "Tough Crowd" },
    h("span", { class: "logo-tough", "aria-hidden": "true" }, ..."TOUGH".split("").map((ch, i) => h("span", { class: `lt lt${i}`, text: ch }))),
    h("span", { class: "logo-crowd", "aria-hidden": "true" }, h("span", { class: "lc-a", text: "Cr" }), h("span", { class: "lc-o", text: "o" }), h("span", { class: "lc-b", text: "wd" })),
  );
}

export const ICONS = {
  pen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1.2-4.4L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.4 18.8z"/><path d="M13.5 7.3l3.2 3.2"/></svg>`,
  cards: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="11" height="14" rx="2" transform="rotate(-8 9 13)"/><rect x="9.5" y="4" width="11" height="14" rx="2"/></svg>`,
  vote: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l4.5 4.5L20 6"/></svg>`,
  mic: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></svg>`,
  seat: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V6a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v5"/><path d="M5 11h14v4H5zM7 15v6M17 15v6"/></svg>`,
  crown: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>`,
  share: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`,
  qr: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 20h2M20 14v2"/></svg>`,
  dots: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`,
  x: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  redraw: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/></svg>`,
  sound: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>`,
  mute: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 5M22 9l-5 5"/></svg>`,
  voice: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8H4l2.3-2.6A8 8 0 0 1 4 12z"/><path d="M9 10.5h6M9 13.5h4"/></svg>`,
  full: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
  tv: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 17.5V21"/></svg>`,
};

export function icon(name, cls = "") {
  return h("span", { class: `ico ${cls}`, svg: ICONS[name] || "" });
}

export const HOW = [
  ["pen", "Answer the prompt", "Write something funny, or play a card from your hand of six."],
  ["vote", "Win the room", "Answers go up anonymously. The room votes, or the judge in the Hot Seat picks."],
  ["mic", "Close the show", "Biggest score after The Closer headlines the night."],
];

export function howTo(cls = "") {
  return h(
    "ol",
    { class: `how ${cls}` },
    HOW.map(([ic, t, d], i) => h("li", null, h("span", { class: "how-n", text: i + 1 }), icon(ic, "how-i"), h("div", null, h("b", { text: t }), h("span", { text: d })))),
  );
}

// ---------- QR (qrcode-generator is loaded as a classic script) ----------
export function qrSvg(text, { dark = "#1b0d0a", light = "transparent", margin = 2 } = {}) {
  if (typeof window.qrcode !== "function") return h("div", { class: "qr-missing" });
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  const s = n + margin * 2;
  return h("span", {
    class: "qr",
    svg: `<svg viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges" role="img" aria-label="QR code to join"><rect width="${s}" height="${s}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`,
  });
}

// ---------- the brick wall (painted once, then used as a CSS background) ----------
export function paintWall() {
  try {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pitchX = 104;
    const pitchY = 48;
    const W = pitchX * 5;
    const H = pitchY * 8;
    const c = document.createElement("canvas");
    c.width = W * dpr;
    c.height = H * dpr;
    const x = c.getContext("2d");
    x.scale(dpr, dpr);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    x.fillStyle = "#0e0706";
    x.fillRect(0, 0, W, H);
    const gap = 4;
    for (let r = 0; r < 8; r++) {
      const y = r * pitchY + gap / 2;
      const off = r % 2 ? pitchX / 2 : 0;
      for (let i = -1; i < 6; i++) {
        const bx = i * pitchX + off + gap / 2;
        const hue = 6 + rnd() * 12;
        const sat = 38 + rnd() * 18;
        const lig = 15 + rnd() * 8;
        const bw = pitchX - gap;
        const bh = pitchY - gap;
        for (const dx of [0, -W, W]) {
          const X = bx + dx;
          if (X > W || X + bw < 0) continue;
          const g = x.createLinearGradient(0, y, 0, y + bh);
          g.addColorStop(0, `hsl(${hue} ${sat}% ${lig + 4}%)`);
          g.addColorStop(0.55, `hsl(${hue} ${sat}% ${lig}%)`);
          g.addColorStop(1, `hsl(${hue} ${sat - 6}% ${lig - 5}%)`);
          x.fillStyle = g;
          x.beginPath();
          x.roundRect ? x.roundRect(X, y, bw, bh, 3) : x.rect(X, y, bw, bh);
          x.fill();
        }
        // pits and specks, drawn on all wrapped copies with the same seed
        const specks = [];
        for (let k = 0; k < 34; k++) specks.push([rnd() * bw, rnd() * bh, rnd() < 0.7 ? `rgba(0,0,0,${0.12 + rnd() * 0.2})` : `rgba(255,200,170,${0.04 + rnd() * 0.05})`, 1 + rnd() * 2.2]);
        for (const dx of [0, -W, W]) {
          for (const [sx, sy, col, sz] of specks) {
            x.fillStyle = col;
            x.fillRect(bx + dx + sx, y + sy, sz, sz);
          }
        }
      }
    }
    return c.toDataURL("image/jpeg", 0.82);
  } catch {
    return null;
  }
}

export function installWall() {
  const url = paintWall();
  if (url) document.documentElement.style.setProperty("--wall", `url("${url}")`);
}

// Text that should shrink until it fits a height (prompts on the big screen).
export function fitText(el, { min = 18, max = 64, step = 2, maxH = null } = {}) {
  if (!el || !el.isConnected) return;
  let size = max;
  el.style.fontSize = size + "px";
  const limit = maxH ?? el.clientHeight;
  let guard = 0;
  while (size > min && el.scrollHeight > limit + 1 && guard++ < 40) {
    size -= step;
    el.style.fontSize = size + "px";
  }
}

export function vibrate(p) {
  try {
    // Chrome logs an error for buzzing before the first tap, so wait for one.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    if (navigator.vibrate) navigator.vibrate(p);
  } catch {}
}
