// IELTS tracker focus server (Cloudflare Worker, free plan).
// The mini app sends how many tasks of each skill are on the next few days' lists;
// the 07:00 bot reminder asks which skill has the most tasks today.
//
// Settings in Cloudflare (Worker → Settings):
//   KV namespace binding  FOCUS      (any KV namespace)
//   Secret                BOT_TOKEN  (the same token as in GitHub; used only to check that
//                                     requests really come from your Telegram mini app)
//   Secret                READ_KEY   (optional; without it the reminder script signs its requests
//                                     with a key derived from BOT_TOKEN, so nothing else is needed)
//
// Routes:
//   POST /sync   {initData, days:{"2026-10-28":{"L":1,"R":2,"W":0,"S":1,"V":0}, ...}}
//   GET  /focus?ids=111,222&date=2026-10-28   header X-Key: READ_KEY or readKey(BOT_TOKEN)
//   GET  /user?ids=111   (same key) → the whole stored doc, for the Sunday weekly report
//   POST /sync may also carry stats (per-day done counts), mocks and ext (small summary)
//        → {"111":{"L":1,"R":2,...}, "222":null}

const ORIGIN = "https://urazovvlv.github.io";
const SKILLS = ["L", "R", "W", "S", "V"];
const KEEP_DAYS = 21;

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

async function hmac(key, data) {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// Telegram's documented check for Mini App initData.
async function checkInitData(initData, token) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac("WebAppData", token);
  if (hex(await hmac(secret, check)) !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (!(age < 30 * 86400)) return null;
  try {
    const user = JSON.parse(p.get("user") || "null");
    return user && user.id ? String(user.id) : null;
  } catch {
    return null;
  }
}

function cleanDays(days) {
  const out = {};
  if (!days || typeof days !== "object") return out;
  for (const [date, c] of Object.entries(days).slice(0, 31)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !c || typeof c !== "object") continue;
    const row = {};
    for (const s of SKILLS) row[s] = Math.max(0, Math.min(99, Math.floor(Number(c[s]) || 0)));
    out[date] = row;
  }
  return out;
}

const STAT_KEYS = ["t", "d", "L", "R", "W", "S", "V", "e", "m"];
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
const str = (v, max) => String(v == null ? "" : v).slice(0, max);
const band = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(9, Math.round(n * 2) / 2)) : null;
};

function cleanStats(stats) {
  const out = {};
  if (!stats || typeof stats !== "object") return out;
  for (const [date, c] of Object.entries(stats).slice(0, 31)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !c || typeof c !== "object") continue;
    const row = {};
    for (const k of STAT_KEYS) row[k] = int(c[k], 999);
    out[date] = row;
  }
  return out;
}

function cleanMocks(mocks) {
  if (!Array.isArray(mocks)) return null;
  return mocks.slice(0, 30).map((m) => ({
    n: int(m && m.n, 999),
    date: /^\d{4}-\d{2}-\d{2}$/.test(m && m.date) ? m.date : "",
    name: str(m && m.name, 60),
    o: band(m && m.o), L: band(m && m.L), R: band(m && m.R), W: band(m && m.W), S: band(m && m.S),
  }));
}

function cleanExt(e) {
  if (!e || typeof e !== "object") return null;
  return {
    top: str(e.top, 60), topn: int(e.topn, 9999), ess: int(e.ess, 9999), mist: int(e.mist, 9999),
    next: Array.isArray(e.next) ? e.next.slice(0, 3).map((x) => str(x, 90)) : [],
    day: int(e.day, 999), days: int(e.days, 999),
  };
}

async function readAllowed(req, env) {
  const given = req.headers.get("X-Key") || "";
  const token = String(env.BOT_TOKEN || "").trim();
  const derived = token ? hex(await hmac(token, "ielts-focus-read")) : "";
  return !!given && (given === env.READ_KEY || given === derived);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/sync" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "bad json" }, 400, cors);
      }
      const id = await checkInitData(String(body.initData || ""), String(env.BOT_TOKEN || "").trim());
      if (!id) return json({ ok: false, error: "not from Telegram" }, 403, cors);
      const key = "u:" + id;
      const old = (await env.FOCUS.get(key, "json")) || {};
      const days = Object.assign({}, old.days, cleanDays(body.days));
      const stats = Object.assign({}, old.stats, cleanStats(body.stats));
      const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
      for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
      for (const d of Object.keys(stats)) if (d < cutoff) delete stats[d];
      const mocks = cleanMocks(body.mocks) || old.mocks || [];
      const ext = cleanExt(body.ext) || old.ext || null;
      await env.FOCUS.put(key, JSON.stringify({ days, stats, mocks, ext, ts: Date.now() }));
      return json({ ok: true }, 200, cors);
    }

    if (url.pathname === "/focus" && req.method === "GET") {
      if (!(await readAllowed(req, env))) return json({ error: "wrong key" }, 403);
      const date = url.searchParams.get("date") || "";
      const ids = (url.searchParams.get("ids") || "").split(",").filter((x) => /^\d+$/.test(x)).slice(0, 50);
      const out = {};
      for (const id of ids) {
        const doc = await env.FOCUS.get("u:" + id, "json");
        out[id] = (doc && doc.days && doc.days[date]) || null;
      }
      return json(out);
    }

    if (url.pathname === "/user" && req.method === "GET") {
      if (!(await readAllowed(req, env))) return json({ error: "wrong key" }, 403);
      const ids = (url.searchParams.get("ids") || "").split(",").filter((x) => /^\d+$/.test(x)).slice(0, 50);
      const out = {};
      for (const id of ids) out[id] = await env.FOCUS.get("u:" + id, "json");
      return json(out);
    }

    if (url.pathname === "/") return new Response("IELTS tracker focus server is running.");
    return json({ error: "not found" }, 404);
  },
};
