// Entry point: ?tv is the big screen, anything else is a phone.
const params = new URLSearchParams(location.search);
if (params.has("tv")) import("./tv.js").then((m) => m.startTv());
else import("./phone.js").then((m) => m.startPhone());
