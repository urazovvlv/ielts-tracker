#!/usr/bin/env python3
"""Sends IELTS reminders to everyone who uses the tracker, each following their own plan.

GitHub Actions runs this three times a day. Secrets:
  BOT_TOKEN  token from @BotFather (required to send)
  APP_URL    the GitHub Pages address of the mini app (adds an "Open tracker" button)
  USERS      JSON list of "reminder codes" copied from each person's app Settings, e.g.
             [{"id":111,"name":"Xushnud","start":"2026-10-19","exam":"","days":60,"target":7.5},
              {"id":222,"name":"Ali","start":"2026-10-27","exam":"2026-12-20","days":54,"target":7}]
  CHAT_ID    (older setup) one chat ID; used with the original 60-day plan unless USERS lists it
  FOCUS_URL  (optional) address of the Cloudflare focus server (worker/worker.js); defaults to FOCUS_DEFAULT
  READ_KEY   (optional) the READ_KEY set on that server; by default a key derived from BOT_TOKEN is used

Without BOT_TOKEN it only prints the messages, which is handy for testing.
Usage: python3 reminders.py morning|evening|night|weekly
"""
import datetime as dt
import hashlib
import hmac
import html
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TZ = dt.timezone(dt.timedelta(hours=5))  # Tashkent
LEGACY_PLAN = {"name": "", "start": "2026-10-19", "exam": "", "days": 60, "target": 7.5}
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
FOCUS = ["Writing Task 2 essay", "Reading: full test, 60 min", "Writing Task 1 report",
         "Reading: question types", "Writing Task 2 essay", "Speaking: full test, recorded",
         "Review the week"]
SKILL_NAMES = {"L": "Listening", "R": "Reading", "W": "Writing", "S": "Speaking", "V": "Vocabulary"}
PACK_SECTIONS = [("idioms", "Idioms"), ("reading", "Reading words"), ("speaking", "Speaking"),
                 ("pron", "Pronunciation"), ("task1", "Writing Task 1"), ("task2", "Writing Task 2")]
FOCUS_DEFAULT = "https://ielts-tracker.urazovvlv.workers.dev"
HERE = os.path.dirname(os.path.abspath(__file__))


def tests(books):
    return [f"Cambridge {b} · Test {t}" for b, ts in books for t in ts]


EARLY = tests([(18, [1, 2, 3, 4]), (19, [1, 2, 3, 4]), (17, [1, 2, 3, 4]), (16, [1, 2, 3, 4]), (15, [1, 2, 3, 4])])
LATE = tests([(20, [1, 2, 3]), (21, [1, 2, 3, 4]), (20, [4]), (19, [3, 4])])
SK = {"L": "Listening", "R": "Reading", "W": "Writing", "S": "Speaking"}
MAINS = {
    "full": {"L": ["Listening: full test, 4 sections + transcript check", "Listening: Sections 3–4 twice + dictation"],
             "R": ["Reading: full test, 60 minutes", "Reading: one passage for each question type you find hard"],
             "W": ["Writing Task 2 essay, 40 minutes", "Writing Task 1 report, 20 minutes + rewrite"],
             "S": ["Speaking: full test recorded (Parts 1–3)", "Speaking: three Part 2 cards + Part 3 questions"]},
    "short": {"L": ["Listening: two sections + transcript check"], "R": ["Reading: one passage in 20 minutes"],
              "W": ["Writing: Task 2 plan + one body paragraph"], "S": ["Speaking: two Part 2 cards, recorded"]},
}
ROTA = [0, 1, 2, 0, 1, 3, -1]  # Mon..Sun, same as mainFor() in index.html


def jround(x):
    """Rounds like JavaScript's Math.round, so the app and the bot agree."""
    return math.floor(x + 0.5)


class Plan:
    """Same rules as buildSchedule() in index.html — keep the two in step."""

    def __init__(self, p):
        self.name = str(p.get("name") or "").strip()
        self.start = dt.date.fromisoformat(p["start"])
        self.exam = dt.date.fromisoformat(p["exam"]) if p.get("exam") else None
        n = (self.exam - self.start).days if self.exam else int(p.get("days") or 60)
        self.days = max(7, min(180, n))
        self.target = float(p.get("target") or 7.5)
        rank = p.get("rank") or ""
        rank = list(rank) if isinstance(rank, (str, list)) else []
        self.rank = rank if sorted(rank) == ["L", "R", "S", "W"] else None
        self.mwd = int(p.get("mwd") or 120)
        self.mwe = int(p.get("mwe") or 180)
        N = self.days
        f1, f2 = jround(N * 14 / 60), jround(N * 35 / 60)
        f3 = N - 8 if N >= 30 else jround(N * 52 / 60)
        self.phases = [(nm, a, b) for nm, a, b in
                       [("Foundation", 1, f1), ("Build", f1 + 1, f2), ("Simulate", f2 + 1, f3), ("Peak", f3 + 1, N)] if a <= b]
        days = [min(7, N)]  # first full mock at the end of week 1, then every 3-4 days
        d, step = days[-1], 3
        while d + step <= N - 4:
            d += step
            days.append(d)
            step = 4 if step == 3 else 3
        self.mocks, e, l = {}, 0, 0
        for d in days:
            if d <= f2:
                self.mocks[d] = EARLY[e] if e < len(EARLY) else f"Practice test {e + 1}"
                e += 1
            elif l < len(LATE):
                self.mocks[d] = LATE[l]
                l += 1
            else:
                self.mocks[d] = EARLY[e] if e < len(EARLY) else f"Practice test {l + 1}"
                e += 1

    def date(self, n):
        return self.start + dt.timedelta(days=n - 1)

    def phase(self, n):
        return next((nm for nm, a, b in self.phases if a <= n <= b), self.phases[-1][0])

    def main_task(self, n):
        if n in self.mocks:
            return f"Full mock · {self.mocks[n]}"
        wd = self.date(n).weekday()
        if not self.rank:
            return FOCUS[wd]
        r = ROTA[wd]
        if r < 0:
            return "Weekly review: redo this week's mistakes"
        skill = self.rank[r]
        mins = self.mwe if wd >= 5 else self.mwd
        options = MAINS["short" if mins < 60 else "full"][skill]
        v = ROTA[:wd].count(r)
        return options[min(v, len(options) - 1)]


def focus_line(counts):
    """Today's focus = the skill with the most tasks on today's list (ties are shown together)."""
    if counts is None:
        return None
    total = sum(counts.get(k, 0) for k in SKILL_NAMES)
    top = max((counts.get(k, 0) for k in SKILL_NAMES), default=0)
    if not top:
        return "Today's focus: not set yet. Tag your tasks with L, R, W, S or Voc in Edit list."
    best = [SKILL_NAMES[k] for k in SKILL_NAMES if counts.get(k, 0) == top]
    return f"🎯 Today's focus: <b>{' + '.join(best)}</b> ({top} of {total} tasks)"


def build(slot, plan, day, today, pack, counts=None):
    e = html.escape
    hi = f", {e(plan.name)}" if plan.name else ""
    if slot == "morning":
        left = plan.days - day
        when = f"{left} days left" + (f" · exam in {(plan.exam - today).days} days" if plan.exam else "")
        lines = [f"<b>Good morning{hi}! Day {day} of {plan.days}</b>",
                 f"{WEEKDAYS[today.weekday()]} {today.day} {today.strftime('%b')} · {when}"]
        focus = focus_line(counts)
        if focus:
            lines += ["", focus]
        if day in plan.mocks:
            lines += ["", f"Mock day: <b>{e(plan.mocks[day])}</b>. Start at 19:00 in exam conditions, with no pauses."]
        if pack:
            lines += ["", "<b>Today's pack</b> · 6 × 10, full version in the app (Daily tab):"]
            for key, title in PACK_SECTIONS:
                theme = (pack.get(key) or {}).get("theme") or ("10 academic words" if key == "reading" else "")
                lines.append(f"• {title}" + (f": {e(theme)}" if theme else ""))
    elif slot == "evening":
        if day in plan.mocks:
            lines = [f"<b>Mock time · Day {day}</b>",
                     f"{e(plan.mocks[day])}: Listening 30 min, Reading 60, Writing 60, Speaking 15.",
                     "Phone on silent. Type your scores in the Progress tab when you finish."]
        else:
            lines = [f"<b>Evening check · Day {day}</b>",
                     "How is your list going? Finish the tasks you planned for today before the day ends."]
    else:
        lines = [f"<b>Log Day {day}{hi}</b>",
                 "Open your tracker and tick the tasks you finished today."]
        if day + 1 in plan.mocks:
            lines.append(f"Tomorrow is a mock day: {e(plan.mocks[day + 1])}. Sleep early.")
        if day == plan.days:
            lines.append("This was the last day of your plan. Well done. Now rest before the exam.")
    return "\n".join(lines)


def send(chat, text, frag=""):
    token = os.environ.get("BOT_TOKEN", "").strip()
    app = os.environ.get("APP_URL", "").strip()
    if not token:
        print(f"--- to {chat} (dry run, no BOT_TOKEN) ---\n{text}\n")
        return True
    payload = {"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}
    if app:
        payload["reply_markup"] = json.dumps({"inline_keyboard": [[{"text": "Open tracker", "web_app": {"url": app + frag}}]]})
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                                 data=urllib.parse.urlencode(payload).encode())
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print(f"Sent to user ending …{str(chat)[-3:]}: {r.status}")
            return True
    except urllib.error.HTTPError as err:
        print(f"Telegram refused the message for user ending …{str(chat)[-3:]}: {err.read().decode()[:200]}")
    except OSError as err:
        print(f"Could not reach Telegram for user ending …{str(chat)[-3:]}: {err}")
    return False


def load_users():
    users = {}
    raw = os.environ.get("USERS", "").strip()
    if raw:
        try:
            data = json.loads(raw)
            for u in data if isinstance(data, list) else [data]:
                if u.get("id") and u.get("start"):
                    users[str(u["id"])] = u
        except (ValueError, AttributeError) as err:
            print(f"The USERS secret is not valid JSON, so it was skipped: {err}")
    legacy = os.environ.get("CHAT_ID", "").strip()
    if legacy and legacy not in users:
        users[legacy] = dict(LEGACY_PLAN, id=legacy)
    return users


def load_pack(day):
    """The daily pack for this plan day; days past the bank repeat it from the start."""
    try:
        with open(os.path.join(HERE, "daily", "index.json"), encoding="utf-8") as f:
            count = int(json.load(f).get("count", 0))
        if count < 1:
            return None
        with open(os.path.join(HERE, "daily", f"{(day - 1) % count + 1:02d}.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError, AttributeError):
        return None


def focus_key():
    key = os.environ.get("READ_KEY", "").strip()
    token = os.environ.get("BOT_TOKEN", "").strip()
    if not key and token:
        key = hmac.new(token.encode(), b"ielts-focus-read", hashlib.sha256).hexdigest()
    return key


def load_docs(ids):
    """Everything the app has synced for each user (for the weekly report), or {}."""
    base = (os.environ.get("FOCUS_URL", "").strip() or FOCUS_DEFAULT).rstrip("/")
    key = focus_key()
    if not base or not key:
        return {}
    req = urllib.request.Request(f"{base}/user?{urllib.parse.urlencode({'ids': ','.join(ids)})}",
                                 headers={"X-Key": key, "User-Agent": "ielts-reminders"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError) as err:
        print(f"Could not read the weekly data: {err}")
        return {}


def short_date(d):
    return f"{WEEKDAYS[d.weekday()][:3]} {d.day} {d.strftime('%b')}"


def build_weekly(plan, day, today, doc):
    e = html.escape
    first = today - dt.timedelta(days=6)
    rng = f"{first.day} {first.strftime('%b')} – {today.day} {today.strftime('%b')}"
    lines = [f"<b>Week {math.ceil(day / 7)} report · {rng}</b>", f"Day {day} of {plan.days} · {plan.days - day} days left", ""]
    stats = (doc or {}).get("stats") or {}
    if not stats:
        lines.append("I have no data from your tracker for this week yet. Open the tracker once, and next Sunday's report will be full.")
        return "\n".join(lines)

    def week(offset):
        out = {"t": 0, "d": 0, "full": 0, "days": 0, "L": 0, "R": 0, "W": 0, "S": 0, "V": 0, "e": 0, "m": 0}
        for i in range(7):
            c = stats.get((today - dt.timedelta(days=offset + i)).isoformat())
            if not c:
                continue
            out["days"] += 1
            for k in ("t", "d", "L", "R", "W", "S", "V", "e", "m"):
                out[k] += int(c.get(k, 0) or 0)
            if c.get("t") and c.get("d") == c.get("t"):
                out["full"] += 1
        return out

    w, prev = week(0), week(7)
    if w["t"]:
        pct = round(w["d"] * 100 / w["t"])
        cmp = ""
        if prev["t"]:
            ppct = round(prev["d"] * 100 / prev["t"])
            diff = pct - ppct
            cmp = f" · last week {ppct}% ({'+' if diff >= 0 else ''}{diff})"
        lines.append(f"<b>Tasks:</b> {w['d']} of {w['t']} done ({pct}%){cmp}")
        lines.append(f"<b>Full days:</b> {w['full']} of 7")
    else:
        lines.append("<b>Tasks:</b> no tasks on your lists this week.")
    skills = [(k, w[k]) for k in ("L", "R", "W", "S")]
    if any(n for _, n in skills) or w["V"]:
        order = sorted(skills + [("V", w["V"])], key=lambda x: -x[1])
        lines.append("<b>By skill:</b> " + " · ".join(f"{SKILL_NAMES[k]} {n}" for k, n in order))
        low = min(skills, key=lambda x: x[1])
        lines.append(f"⚠️ Least practised: <b>{SKILL_NAMES[low[0]]}</b> ({low[1]} task{'s' if low[1] != 1 else ''}). Give it more time next week.")
    elif w["d"]:
        lines.append("Tag your tasks with L, R, W or S in Edit list to see which skill gets the least practice.")

    mocks = sorted([m for m in (doc.get("mocks") or []) if m.get("o") is not None], key=lambda m: m.get("n", 0))
    this_week = [m for m in mocks if first.isoformat() <= (m.get("date") or "") <= today.isoformat()]
    lines.append("")
    if this_week:
        lines.append("<b>Mocks this week:</b>")
        for m in this_week:
            parts = " · ".join(f"{k} {m[k]:.1f}" for k in ("L", "R", "W", "S") if m.get(k) is not None)
            lines.append(f"• Day {m.get('n')} · {e(m.get('name') or '')}: <b>{m['o']:.1f}</b> ({parts})")
        latest = this_week[-1]
        before = [m for m in mocks if m.get("n", 0) < latest.get("n", 0)]
        if before:
            diff = latest["o"] - before[-1]["o"]
            lines.append(f"Change since your previous mock: {'+' if diff >= 0 else ''}{diff:.1f}")
        gap = plan.target - latest["o"]
        lines.append(f"Target {plan.target:.1f}: " + ("reached 🎯" if gap <= 0 else f"{gap:.1f} to go"))
    elif mocks:
        lines.append(f"<b>Latest mock:</b> Day {mocks[-1].get('n')} · {mocks[-1]['o']:.1f}")
    else:
        lines.append("<b>Mocks:</b> none logged yet.")

    ext = doc.get("ext") or {}
    extra = []
    if w["e"]:
        extra.append(f"{w['e']} essay{'s' if w['e'] != 1 else ''} saved")
    if w["m"]:
        extra.append(f"{w['m']} mistake{'s' if w['m'] != 1 else ''} logged")
    if extra:
        lines.append("<b>Practice:</b> " + " · ".join(extra))
    if ext.get("top"):
        lines.append(f"Most repeated mistake: <b>{e(ext['top'])}</b> ({ext.get('topn', 0)}×). Review it before the next mock.")
    upcoming = []
    for x in ext.get("next") or []:
        d, _, name = str(x).partition("|")
        try:
            dd = dt.date.fromisoformat(d)
        except ValueError:
            continue
        if dd > today:
            upcoming.append(f"{short_date(dd)} · {e(name)}")
    if upcoming:
        lines += ["", "<b>Next mocks:</b> " + "; ".join(upcoming)]
    return "\n".join(lines)


def load_focus(ids, today):
    """Skill counts per user for today from the focus server, or {} if it is not set up or unreachable."""
    base = (os.environ.get("FOCUS_URL", "").strip() or FOCUS_DEFAULT).rstrip("/")
    key = focus_key()
    if not base or not key:
        return {}
    q = urllib.parse.urlencode({"ids": ",".join(ids), "date": today.isoformat()})
    req = urllib.request.Request(f"{base}/focus?{q}", headers={"X-Key": key, "User-Agent": "ielts-reminders"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError) as err:
        print(f"Could not read today's focus, so the message goes without it: {err}")
        return {}


def main():
    slot = (sys.argv[1] if len(sys.argv) > 1 else "morning").strip() or "morning"
    if slot not in ("morning", "evening", "night", "weekly"):
        sys.exit(f"Unknown reminder '{slot}'. Use morning, evening, night or weekly.")
    users = load_users()
    if not users:
        sys.exit("No users: add the USERS (or CHAT_ID) secret.")
    today = dt.datetime.now(TZ).date()
    focus = load_focus(list(users), today) if slot == "morning" else {}
    docs = load_docs(list(users)) if slot == "weekly" else {}
    failures = 0
    for chat, raw in users.items():
        try:
            plan = Plan(raw)
        except (KeyError, ValueError, TypeError) as err:
            print(f"Skipped user ending …{chat[-3:]}: their plan is not valid ({err})")
            failures += 1
            continue
        day = (today - plan.start).days + 1
        if not 1 <= day <= plan.days:
            print(f"User ending …{chat[-3:]}: day {day} is outside their {plan.days}-day plan, so no reminder.")
            continue
        if slot == "weekly" and day % 7 and day != plan.days and not os.environ.get("FORCE_WEEKLY"):
            print(f"User ending …{chat[-3:]}: day {day} is not the last day of a plan week, so no report.")
            continue
        if slot == "weekly":
            ok = send(chat, build_weekly(plan, day, today, docs.get(chat)), "#prog")
        elif slot == "morning":
            text = build(slot, plan, day, today, load_pack(day), focus.get(chat) if focus else None)
            ok = send(chat, text, "#daily")
        else:
            ok = send(chat, build(slot, plan, day, today, None))
        if not ok:
            failures += 1
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
