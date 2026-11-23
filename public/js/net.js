// WebSocket with auto-reconnect, a send queue, and a clock that tracks the server's.
//
// The socket opens at the page's own directory, so behind the play.jadon.me
// proxy (/crowd/) it reaches this game, and on a bare host it reaches "/".

export class Net {
  constructor({ onMsg, onOpen, onClose } = {}) {
    this.onMsg = onMsg;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.ws = null;
    this.queue = [];
    this.retry = 0;
    this.samples = [];
    this.offset = 0; // server time minus local time
    this.rtt = 0;
    this.syncTimer = null;
    this.stopped = false;
  }

  base() {
    return location.pathname.replace(/[^/]*$/, "");
  }

  connect() {
    this.stopped = false;
    const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + this.base();
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.again();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      if (this.onOpen) this.onOpen();
      const q = this.queue;
      this.queue = [];
      for (const m of q) this.send(m);
      this.syncBurst();
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === "pong") return this.onPong(m);
      if (this.onMsg) this.onMsg(m);
    };
    ws.onclose = (e) => {
      clearInterval(this.syncTimer);
      if (this.ws !== ws) return;
      if (this.onClose) this.onClose(e);
      if (e.code === 4000 || this.stopped) return; // replaced by another tab
      this.again();
    };
    ws.onerror = () => {};
  }

  again() {
    const delay = Math.min(5000, 350 * Math.pow(1.7, this.retry++));
    setTimeout(() => {
      if (!this.stopped && (!this.ws || this.ws.readyState >= 2)) this.connect();
    }, delay);
  }

  get open() {
    return !!this.ws && this.ws.readyState === 1;
  }

  send(m, { queue = true } = {}) {
    if (this.open) this.ws.send(JSON.stringify(m));
    else if (queue) this.queue.push(m);
  }

  // Phones that come back from sleep often hold a dead socket for a while.
  kick() {
    if (!this.open) {
      try {
        this.ws && this.ws.close();
      } catch {}
      this.connect();
    } else this.ping();
  }

  syncBurst() {
    for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 180);
    clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => this.ping(), 6000);
  }
  ping() {
    this.send({ t: "ping", c: Date.now() }, { queue: false });
  }
  onPong(m) {
    const now = Date.now();
    const rtt = now - m.c;
    if (rtt < 0 || rtt > 5000) return;
    this.samples.push([rtt, m.s - (m.c + rtt / 2)]);
    if (this.samples.length > 10) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b[0] < a[0] ? b : a));
    this.rtt = best[0];
    this.offset = best[1];
  }
  serverNow() {
    return Date.now() + this.offset;
  }
}
