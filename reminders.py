#!/usr/bin/env python3
"""Sends IELTS reminders to everyone who uses the tracker, each following their own plan.

GitHub Actions runs this three times a day. Secrets:
  BOT_TOKEN  token from @BotFather (required to send)
  APP_URL    the GitHub Pages address of the mini app (adds an "Open tracker" button)
  USERS      JSON list of "reminder codes" copied from each person's app Settings, e.g.
             [{"id":111,"name":"Xushnud","start":"2026-10-19","exam":"","days":60,"target":7.5},
              {"id":222,"name":"Ali","start":"2026-10-27","exam":"2026-12-20","days":54,"target":7}]
  CHAT_ID    (older setup) one chat ID; used with the original 60-day plan unless USERS lists it

Without BOT_TOKEN it only prints the messages, which is handy for testing.
Usage: python3 reminders.py morning|evening|night
"""
import datetime as dt
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


def tests(books):
    return [f"Cambridge {b} · Test {t}" for b, ts in books for t in ts]


EARLY = tests([(18, [1, 2, 3, 4]), (19, [1, 2, 3, 4]), (17, [1, 2, 3, 4]), (16, [1, 2, 3, 4]), (15, [1, 2, 3, 4])])
LATE = tests([(20, [1, 2, 3]), (21, [1, 2, 3, 4]), (20, [4]), (19, [3, 4])])


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
        N = self.days
        f1, f2 = jround(N * 14 / 60), jround(N * 35 / 60)
        f3 = N - 8 if N >= 30 else jround(N * 52 / 60)
        self.phases = [(nm, a, b) for nm, a, b in
                       [("Foundation", 1, f1), ("Build", f1 + 1, f2), ("Simulate", f2 + 1, f3), ("Peak", f3 + 1, N)] if a <= b]
        days = [1]
        for d in range(2, math.floor(N * 0.7) + 1):
            if self.date(d).weekday() == 6:
                days.append(d)
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
        return f"Full mock · {self.mocks[n]}" if n in self.mocks else FOCUS[self.date(n).weekday()]


def build(slot, plan, day, today, word):
    e = html.escape
    hi = f", {e(plan.name)}" if plan.name else ""
    if slot == "morning":
        left = f"exam in {(plan.exam - today).days} days" if plan.exam else f"{plan.days - day} days left"
        lines = [f"<b>Good morning{hi}! Day {day}/{plan.days}</b>",
                 f"{WEEKDAYS[today.weekday()]} {today.day} {today.strftime('%b')} · {plan.phase(day)} phase · {left}", "",
                 f"Main task: <b>{e(plan.main_task(day))}</b>"]
        if day in plan.mocks:
            lines.append("Mock day: start at 19:00 in exam conditions, with no pauses.")
        if word:
            lines += ["", f"Word of the day: <b>{e(word['w'])}</b> — {e(word['uz'])}", f"<i>{e(word['ex'])}</i>"]
        lines += ["", "Minimum today: 20 words · 1 Speaking recording · 1 Listening section."]
    elif slot == "evening":
        if day in plan.mocks:
            lines = [f"<b>Mock time · Day {day}</b>",
                     f"{e(plan.mocks[day])}: Listening 30 min, Reading 60, Writing 60, Speaking 15.",
                     "Phone on silent. Type your scores in the Mocks tab when you finish."]
        else:
            lines = [f"<b>Evening block · Day {day}</b>",
                     "Listening section, then read the transcript and find why each answer was missed.",
                     "Then 20 minutes of grammar on one error type."]
    else:
        lines = [f"<b>Log Day {day}{hi}</b>",
                 "Tick your tasks, add hours, words and energy, and write one thing to fix tomorrow."]
        if day + 1 in plan.mocks:
            lines.append(f"Tomorrow is a mock day: {e(plan.mocks[day + 1])}. Sleep early.")
        if day == plan.days:
            lines.append("This was the last day of your plan. Well done. Now rest before the exam.")
    return "\n".join(lines)


def send(chat, text):
    token = os.environ.get("BOT_TOKEN", "").strip()
    app = os.environ.get("APP_URL", "").strip()
    if not token:
        print(f"--- to {chat} (dry run, no BOT_TOKEN) ---\n{text}\n")
        return True
    payload = {"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}
    if app:
        payload["reply_markup"] = json.dumps({"inline_keyboard": [[{"text": "Open tracker", "web_app": {"url": app}}]]})
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


def main():
    slot = (sys.argv[1] if len(sys.argv) > 1 else "morning").strip() or "morning"
    if slot not in ("morning", "evening", "night"):
        sys.exit(f"Unknown reminder '{slot}'. Use morning, evening or night.")
    users = load_users()
    if not users:
        sys.exit("No users: add the USERS (or CHAT_ID) secret.")
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "daily.json"), encoding="utf-8") as f:
            words = json.load(f)
    except (OSError, ValueError):
        words = []
    today = dt.datetime.now(TZ).date()
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
        word = words[(day - 1) % len(words)] if words else None
        if not send(chat, build(slot, plan, day, today, word)):
            failures += 1
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
