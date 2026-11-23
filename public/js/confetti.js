// Confetti burst on a full-screen canvas. Fires and cleans itself up.

const COLORS = ["#ff4fa3", "#ffc23d", "#2fe3c8", "#9b7bff", "#fff3e0", "#ff7a45"];

export function confetti({ count = 160, from = "top", duration = 4200 } = {}) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas");
  c.className = "confetti";
  document.body.append(c);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = innerWidth;
  const H = innerHeight;
  c.width = W * dpr;
  c.height = H * dpr;
  const x = c.getContext("2d");
  x.scale(dpr, dpr);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const fromSides = from === "sides";
    const left = i % 2 === 0;
    parts.push({
      x: fromSides ? (left ? -10 : W + 10) : Math.random() * W,
      y: fromSides ? H * (0.55 + Math.random() * 0.3) : -20 - Math.random() * H * 0.4,
      vx: fromSides ? (left ? 1 : -1) * (5 + Math.random() * 9) : (Math.random() - 0.5) * 3,
      vy: fromSides ? -(9 + Math.random() * 9) : 1.5 + Math.random() * 3,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      w: 6 + Math.random() * 7,
      h: 9 + Math.random() * 10,
      col: COLORS[i % COLORS.length],
      wob: Math.random() * 10,
    });
  }
  const t0 = performance.now();
  let last = t0;
  function frame(t) {
    const dt = Math.min(2.5, (t - last) / 16.7);
    last = t;
    const age = t - t0;
    x.clearRect(0, 0, W, H);
    const fade = age > duration - 900 ? Math.max(0, (duration - age) / 900) : 1;
    for (const p of parts) {
      p.vy += 0.18 * dt;
      p.vx *= 0.99;
      p.vy = Math.min(p.vy, 5.5);
      p.x += (p.vx + Math.sin(p.wob + age / 300) * 0.6) * dt;
      p.y += p.vy * dt;
      p.r += p.vr * dt;
      x.save();
      x.globalAlpha = fade;
      x.translate(p.x, p.y);
      x.rotate(p.r);
      x.scale(1, Math.cos(age / 180 + p.wob));
      x.fillStyle = p.col;
      x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      x.restore();
    }
    if (age < duration) requestAnimationFrame(frame);
    else c.remove();
  }
  requestAnimationFrame(frame);
}
