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
// Reminders: Cron Triggers in wrangler.jsonc send the 07:00 / 19:15 / 21:15 messages, the 23:00 daily report + survey prompt, and the weekly report
// to everyone whose app has synced a plan (ext.plan). GET /run?slot=…&force=1&dry=1 (same key) runs one by hand.
//
// Routes:
//   POST /sync   {initData, days:{"2026-10-28":{"L":1,"R":2,"W":0,"S":1,"V":0}, ...}}
//   GET  /focus?ids=111,222&date=2026-10-28   header X-Key: READ_KEY or readKey(BOT_TOKEN)
//   GET  /user?ids=111   (same key) → the whole stored doc, for the Sunday weekly report
//   POST /sync may also carry stats (per-day done counts), mocks and ext (small summary)
//        → {"111":{"L":1,"R":2,...}, "222":null}

const ORIGIN = "https://urazovvlv.github.io";
const SKILLS = ["L", "R", "W", "S", "V", "G"];
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

const STAT_KEYS = ["t", "d", "L", "R", "W", "S", "V", "G", "e", "m"];
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
    plan: e.plan && typeof e.plan === "object" && /^\d{4}-\d{2}-\d{2}$/.test(e.plan.start)
      ? { name: str(e.plan.name, 40), start: e.plan.start, exam: /^\d{4}-\d{2}-\d{2}$/.test(e.plan.exam) ? e.plan.exam : "",
          days: int(e.plan.days, 400), target: band(e.plan.target) || 7.5 }
      : null,
    ms: e.ms && typeof e.ms === "object"
      ? Object.fromEntries(Object.entries(e.ms).slice(0, 40).filter(([k]) => /^\d{1,3}$/.test(k)).map(([k, v]) => [k, str(v, 60)]))
      : {},
  };
}

function cleanTl(tl) {
  const out = {};
  if (!tl || typeof tl !== "object") return out;
  for (const [date, list] of Object.entries(tl).slice(0, 4)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(list)) continue;
    out[date] = list.slice(0, 40).map((x) => [str(Array.isArray(x) ? x[0] : "", 80), str(Array.isArray(x) ? x[1] : "", 1), Array.isArray(x) && x[2] ? 1 : 0]);
  }
  return out;
}

function cleanSv(sv) {
  const out = {};
  if (!sv || typeof sv !== "object") return out;
  for (const [date, q] of Object.entries(sv).slice(0, 31)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !q || typeof q !== "object") continue;
    out[date] = { h: Math.max(0, Math.min(16, Math.round((Number(q.h) || 0) * 2) / 2)), w: int(q.w, 500), sk: str(q.sk, 1), r: int(q.r, 5),
      good: str(q.good, 240), bad: str(q.bad, 240), tmr: str(q.tmr, 240) };
  }
  return out;
}

// Private: only these Telegram user IDs may sync or get reminders (wrangler.jsonc vars.ALLOWED_IDS, comma-separated).
const allowedIds = (env) => String(env.ALLOWED_IDS || "5020539876").split(",").map((x) => x.trim()).filter(Boolean);

async function readAllowed(req, env) {
  const given = req.headers.get("X-Key") || "";
  const token = String(env.BOT_TOKEN || "").trim();
  const derived = token ? hex(await hmac(token, "ielts-focus-read")) : "";
  return !!given && (given === env.READ_KEY || given === derived);
}

/* ---------- Reminders (Cloudflare Cron Triggers, Tashkent time) ---------- */
const APP = "https://urazovvlv.github.io/ielts-tracker/";
const SLOTS = { "0 2 * * *": ["morning"], "15 14 * * *": ["evening"], "15 16 * * *": ["night"], "0 18 * * *": ["daily", "weekly"], "0 7 * * TUE,THU,SAT": ["cambridge"] };
const RATE = ["", "Bad", "Weak", "OK", "Good", "Great"];
const NAMES = { L: "Listening", R: "Reading", W: "Writing", S: "Speaking", V: "Vocabulary", G: "Grammar" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PACK = [["grammar", "Grammar"], ["idioms", "Idioms"], ["reading", "Reading words"], ["speaking", "Speaking"], ["pron", "Pronunciation"], ["task1", "Writing Task 1"], ["task2", "Writing Task 2"]];
const esc = (t) => String(t == null ? "" : t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const tashToday = () => new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
const dOf = (iso) => new Date(iso + "T00:00:00Z");
const addDays = (iso, n) => new Date(dOf(iso).getTime() + n * 86400000).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((dOf(b) - dOf(a)) / 86400000);
const nice = (iso, long) => { const d = dOf(iso); return `${long ? WEEKDAYS[d.getUTCDay()] : WEEKDAYS[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const b1 = (v) => Number(v).toFixed(1);

async function getPack(day) {
  try {
    const idx = await (await fetch(APP + "daily/index.json", { cf: { cacheTtl: 600 } })).json();
    const count = Number(idx.count) || 0;
    if (!count) return null;
    const k = String(((day - 1) % count) + 1).padStart(2, "0");
    return await (await fetch(APP + `daily/${k}.json`, { cf: { cacheTtl: 600 } })).json();
  } catch { return null; }
}

function focusLine(c) {
  if (!c) return "";
  const total = Object.keys(NAMES).reduce((a, k) => a + (c[k] || 0), 0);
  const top = Math.max(...Object.keys(NAMES).map((k) => c[k] || 0));
  if (!top) return "Today's focus: not set yet. Tag your tasks with L, R, W, S, Voc or G in Edit list.";
  const best = Object.keys(NAMES).filter((k) => (c[k] || 0) === top).map((k) => NAMES[k]);
  return `🎯 Today's focus: <b>${best.join(" + ")}</b> (${top} of ${total} tasks)`;
}

function weekly(doc, plan, day, days, today) {
  const first = addDays(today, -6), stats = doc.stats || {};
  const L = [`<b>Week ${Math.ceil(day / 7)} report · ${dOf(first).getUTCDate()} ${MON[dOf(first).getUTCMonth()]} – ${dOf(today).getUTCDate()} ${MON[dOf(today).getUTCMonth()]}</b>`, `Day ${day} of ${days} · ${days - day} days left`, ""];
  const wk = (off) => {
    const o = { t: 0, d: 0, full: 0, L: 0, R: 0, W: 0, S: 0, V: 0, G: 0, e: 0, m: 0 };
    for (let i = 0; i < 7; i++) {
      const c = stats[addDays(today, -(off + i))];
      if (!c) continue;
      for (const k of ["t", "d", "L", "R", "W", "S", "V", "G", "e", "m"]) o[k] += c[k] || 0;
      if (c.t && c.d === c.t) o.full++;
    }
    return o;
  };
  const w = wk(0), p = wk(7);
  if (w.t) {
    const pct = Math.round((w.d * 100) / w.t);
    let cmp = "";
    if (p.t) { const pp = Math.round((p.d * 100) / p.t), df = pct - pp; cmp = ` · last week ${pp}% (${df >= 0 ? "+" : ""}${df})`; }
    L.push(`<b>Tasks:</b> ${w.d} of ${w.t} done (${pct}%)${cmp}`, `<b>Full days:</b> ${w.full} of 7`);
  } else L.push("<b>Tasks:</b> no tasks on your lists this week.");
  const sk = ["L", "R", "W", "S"].map((k) => [k, w[k]]);
  if (sk.some(([, n]) => n) || w.V || w.G) {
    L.push("<b>By skill:</b> " + [...sk, ["V", w.V], ["G", w.G]].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${NAMES[k]} ${n}`).join(" · "));
    const low = sk.reduce((a, b) => (b[1] < a[1] ? b : a));
    L.push(`⚠️ Least practised: <b>${NAMES[low[0]]}</b> (${low[1]} task${low[1] === 1 ? "" : "s"}). Give it more time next week.`);
  } else if (w.d) L.push("Tag your tasks with L, R, W or S in Edit list to see which skill gets the least practice.");
  const sv = doc.sv || {};
  const hrs = (off) => { let h = 0, w2 = 0, n = 0; for (let i = 0; i < 7; i++) { const q = sv[addDays(today, -(off + i))]; if (q) { h += q.h || 0; w2 += q.w || 0; n++; } } return { h, w: w2, n }; };
  const hw = hrs(0), hp = hrs(7);
  if (hw.n) L.push(`<b>Study time:</b> ${+hw.h.toFixed(1)} h (${(hw.h / hw.n).toFixed(1)} h a day)${hp.n ? ` · last week ${+hp.h.toFixed(1)} h` : ""}`, `<b>New words:</b> ${hw.w}`);
  const mocks = (doc.mocks || []).filter((m) => m.o != null).sort((a, b) => a.n - b.n);
  const tw = mocks.filter((m) => m.date >= first && m.date <= today);
  L.push("");
  if (tw.length) {
    L.push("<b>Mocks this week:</b>");
    for (const m of tw) L.push(`• Day ${m.n} · ${esc(m.name)}: <b>${b1(m.o)}</b> (${["L", "R", "W", "S"].filter((k) => m[k] != null).map((k) => `${k} ${b1(m[k])}`).join(" · ")})`);
    const last = tw[tw.length - 1], before = mocks.filter((m) => m.n < last.n);
    if (before.length) { const df = last.o - before[before.length - 1].o; L.push(`Change since your previous mock: ${df >= 0 ? "+" : ""}${b1(df)}`); }
    const gap = plan.target - last.o;
    L.push(`Target ${b1(plan.target)}: ${gap <= 0 ? "reached 🎯" : b1(gap) + " to go"}`);
  } else if (mocks.length) L.push(`<b>Latest mock:</b> Day ${mocks[mocks.length - 1].n} · ${b1(mocks[mocks.length - 1].o)}`);
  else L.push("<b>Mocks:</b> none logged yet.");
  const ext = doc.ext || {}, extra = [];
  if (w.e) extra.push(`${w.e} essay${w.e === 1 ? "" : "s"} saved`);
  if (w.m) extra.push(`${w.m} mistake${w.m === 1 ? "" : "s"} logged`);
  if (extra.length) L.push("<b>Practice:</b> " + extra.join(" · "));
  if (ext.top) L.push(`Most repeated mistake: <b>${esc(ext.top)}</b> (${ext.topn}×). Review it before the next mock.`);
  const up = (ext.next || []).map((x) => x.split("|")).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d > today).map(([d, n]) => `${nice(d)} · ${esc(n)}`);
  if (up.length) L.push("", "<b>Next mocks:</b> " + up.join("; "));
  return L.join("\n");
}

function dailyReport(doc, plan, day, days, today) {
  const list = (doc.tl || {})[today];
  const L = [`<b>Day ${day} report · ${nice(today, true)}</b>`, ""];
  if (!list || !list.length) L.push("No tasks on today's list.");
  else {
    const done = list.filter((x) => x[2]), left = list.filter((x) => !x[2]);
    const tag = (x) => (x[1] ? `[${x[1] === "V" ? "Voc" : x[1]}] ` : "");
    L.push(`<b>Done ${done.length} of ${list.length}</b>${done.length === list.length ? " — every task finished 🎯" : ""}`);
    for (const x of done) L.push(`✅ ${tag(x)}${esc(x[0])}`);
    if (left.length) { L.push("", `<b>Not done (${left.length})</b>`); for (const x of left) L.push(`❌ ${tag(x)}${esc(x[0])}`); }
  }
  const q = (doc.sv || {})[today];
  L.push("");
  if (q) {
    L.push(`<b>Your survey:</b> ${q.h} h · ${q.w} new words${q.sk ? " · main skill " + (NAMES[q.sk] || q.sk) : ""}${q.r ? " · day: " + RATE[q.r] : ""}`);
    if (q.bad) L.push(`Weak points: <i>${esc(q.bad)}</i>`);
    if (q.tmr) L.push(`Tomorrow: <i>${esc(q.tmr)}</i>`);
  } else L.push("📝 <b>Daily survey:</b> 8 quick questions about today (about 1 minute). Tap the button below.");
  return L.join("\n");
}

async function buildMessage(slot, doc, today) {
  const ext = doc.ext || {}, plan = ext.plan;
  if (!plan) return null;
  const day = diffDays(plan.start, today) + 1, days = plan.days || ext.days || 60;
  if (day < 1 || day > days) return null;
  const ms = ext.ms || {}, hi = plan.name ? `, ${esc(plan.name)}` : "";
  if (slot === "daily") {
    const filled = !!(doc.sv || {})[today];
    return { text: dailyReport(doc, plan, day, days, today), frag: filled ? "#prog" : "#survey", button: filled ? "Open tracker" : "Fill in today's survey" };
  }
  if (slot === "weekly") {
    if (day % 7 && day !== days) return null;
    return { text: weekly(doc, plan, day, days, today), frag: "#prog" };
  }
  if (slot === "cambridge") {
    const wd = (d) => new Date(d + "T00:00:00Z").getUTCDay();
    if (![2, 4, 6].includes(wd(today))) return null;
    let s = 0;
    for (let i = 0; i < day; i++) if ([2, 4, 6].includes(wd(addDays(plan.start, i)))) s++;
    let st = null;
    try { const r = await fetch(APP + "books/index.json", { cf: { cacheTtl: 300 } }); if (r.ok) st = ((await r.json()).sets || []).find((x) => x.day === s) || null; } catch (e) {}
    const L = [`<b>📘 Cambridge vocabulary · Day ${s}</b>`];
    if (st) L.push(`${esc(st.title)}: ${st.words} words and keyword tables.`, "", "1. Learn the words passage by passage (🔊 for pronunciation).", "2. Open Keywords: see how each question paraphrases the passage.", "3. Tap + to send the hard words to My words for review.");
    else L.push("No new set today. Review the earlier sets and their keyword tables.");
    L.push("", "It is on today's list in the tracker. Tick it when you finish.");
    return { text: L.join("\n"), frag: "#books", button: "Open Cambridge" };
  }
  if (slot === "morning") {
    const left = days - day, exam = plan.exam ? diffDays(today, plan.exam) : null;
    const L = [`<b>Good morning${hi}! Day ${day} of ${days}</b>`, `${nice(today, true)} · ${left} days left${exam != null && exam >= 0 ? ` · exam in ${exam} days` : ""}`];
    const f = focusLine((doc.days || {})[today]);
    if (f) L.push("", f);
    if (ms[day]) L.push("", `Mock day: <b>${esc(ms[day])}</b>. Start at 19:00 in exam conditions, with no pauses.`);
    const pack = await getPack(day);
    if (pack) {
      L.push("", "<b>Today's pack</b> · full version in the app (Daily tab):");
      for (const [k, t] of PACK) { const th = (pack[k] && pack[k].theme) || (k === "reading" ? "10 academic words" : ""); L.push(`• ${t}${th ? ": " + esc(th) : ""}`); }
    }
    return { text: L.join("\n"), frag: "#daily" };
  }
  if (slot === "evening") {
    const L = ms[day]
      ? [`<b>Mock time · Day ${day}</b>`, `${esc(ms[day])}: Listening 30 min, Reading 60, Writing 60, Speaking 15.`, "Phone on silent. Type your scores in the Progress tab when you finish."]
      : [`<b>Evening check · Day ${day}</b>`, "How is your list going? Finish the tasks you planned for today before the day ends."];
    return { text: L.join("\n"), frag: "" };
  }
  const L = [`<b>Log Day ${day}${hi}</b>`, "Open your tracker and tick the tasks you finished today."];
  if (ms[day + 1]) L.push(`Tomorrow is a mock day: ${esc(ms[day + 1])}. Sleep early.`);
  if (day === days) L.push("This was the last day of your plan. Well done. Now rest before the exam.");
  return { text: L.join("\n"), frag: "" };
}

async function tgSend(env, chat, msg) {
  const r = await fetch(`https://api.telegram.org/bot${String(env.BOT_TOKEN || "").trim()}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: msg.text, parse_mode: "HTML", disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: msg.button || "Open tracker", web_app: { url: APP + msg.frag } }]] } }),
  });
  return r.ok;
}

async function runSlot(env, slot, opts = {}) {
  const today = opts.date || tashToday(), out = [];
  let cursor;
  do {
    const page = await env.FOCUS.list({ prefix: "u:", cursor });
    for (const k of page.keys) {
      const id = k.name.slice(2);
      if (opts.only && opts.only !== id) continue;
      if (!allowedIds(env).includes(id)) continue;
      const doc = await env.FOCUS.get(k.name, "json");
      if (!doc) continue;
      const msg = await buildMessage(slot, doc, today);
      if (!msg) { out.push([id, "skip"]); continue; }
      const mark = `sent:${id}:${today}:${slot}`;
      if (!opts.force && (await env.FOCUS.get(mark))) { out.push([id, "already"]); continue; }
      if (opts.dry) { out.push([id, msg.text]); continue; }
      const ok = await tgSend(env, id, msg);
      if (ok) await env.FOCUS.put(mark, "1", { expirationTtl: 3 * 86400 });
      out.push([id, ok ? "sent" : "failed"]);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

export default {
  async scheduled(event, env, ctx) {
    const slots = SLOTS[event.cron] || [];
    ctx.waitUntil((async () => { for (const s of slots) await runSlot(env, s); })());
  },

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
      if (!allowedIds(env).includes(id)) return json({ ok: false, error: "private" }, 403, cors);
      const key = "u:" + id;
      const old = (await env.FOCUS.get(key, "json")) || {};
      const days = Object.assign({}, old.days, cleanDays(body.days));
      const stats = Object.assign({}, old.stats, cleanStats(body.stats));
      const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
      for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
      for (const d of Object.keys(stats)) if (d < cutoff) delete stats[d];
      const tl = Object.assign({}, old.tl, cleanTl(body.tl));
      const sv = Object.assign({}, old.sv, cleanSv(body.sv));
      for (const o of [tl, sv]) for (const d of Object.keys(o)) if (d < cutoff) delete o[d];
      const mocks = cleanMocks(body.mocks) || old.mocks || [];
      const ext = cleanExt(body.ext) || old.ext || null;
      await env.FOCUS.put(key, JSON.stringify({ days, stats, mocks, ext, tl, sv, ts: Date.now() }));
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

    if (url.pathname === "/run" && req.method === "GET") {
      if (!(await readAllowed(req, env))) return json({ error: "wrong key" }, 403);
      const slot = url.searchParams.get("slot") || "";
      if (!["morning", "evening", "night", "daily", "weekly", "cambridge"].includes(slot)) return json({ error: "bad slot" }, 400);
      const res = await runSlot(env, slot, {
        force: url.searchParams.get("force") === "1", dry: url.searchParams.get("dry") === "1",
        only: url.searchParams.get("id") || "", date: /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") || "") ? url.searchParams.get("date") : "",
      });
      return json(res);
    }

    if (url.pathname === "/") return new Response("IELTS tracker focus server is running.");
    return json({ error: "not found" }, 404);
  },
};
