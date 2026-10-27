#!/usr/bin/env python3
"""Sends the IELTS 60-day challenge reminders to Telegram.

GitHub Actions runs this file three times a day. It needs three secrets:
BOT_TOKEN (from @BotFather), CHAT_ID (shown in the mini app's Settings)
and APP_URL (your GitHub Pages address). Without them it only prints the
message, which is handy for testing.

Usage: python3 reminders.py morning|evening|night
"""
import datetime as dt
import html
import json
import os
import sys
import urllib.parse
import urllib.request

START = dt.date(2026, 10, 19)          # Day 1 (a Monday)
DAYS = 60
TZ = dt.timezone(dt.timedelta(hours=5))  # Tashkent

MOCKS = {1: "Cambridge 18 · Test 1", 7: "Cambridge 18 · Test 2", 14: "Cambridge 18 · Test 3",
         21: "Cambridge 18 · Test 4", 28: "Cambridge 19 · Test 1", 35: "Cambridge 19 · Test 2",
         42: "Cambridge 20 · Test 1", 45: "Cambridge 20 · Test 2", 49: "Cambridge 20 · Test 3",
         52: "Cambridge 21 · Test 1", 56: "Cambridge 21 · Test 2"}
FOCUS = ["Writing Task 2 essay", "Reading: full test, 60 min", "Writing Task 1 report",
         "Reading: question types", "Writing Task 2 essay", "Speaking: full test, recorded",
         "Review the week"]
PHASES = [("Foundation", 1, 14), ("Build", 15, 35), ("Simulate", 36, 52), ("Peak", 53, 60)]
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def phase(day):
    return next(name for name, a, b in PHASES if a <= day <= b)


def main_task(day):
    return f"Full mock · {MOCKS[day]}" if day in MOCKS else FOCUS[(day - 1) % 7]


def build(slot, day, today, word):
    e = html.escape
    left = DAYS - day
    if slot == "morning":
        lines = [f"<b>Day {day}/60 · {WEEKDAYS[today.weekday()]} {today.day} {today.strftime('%b')}</b>",
                 f"{phase(day)} phase · {left} days left", "",
                 f"Main task: <b>{e(main_task(day))}</b>"]
        if day in MOCKS:
            lines.append("Mock day: start at 19:00 in exam conditions, with no pauses.")
        if word:
            lines += ["", f"Word of the day: <b>{e(word['w'])}</b> — {e(word['uz'])}", f"<i>{e(word['ex'])}</i>"]
        lines += ["", "Minimum today: 20 words · 1 Speaking recording · 1 Listening section."]
    elif slot == "evening":
        if day in MOCKS:
            lines = [f"<b>Mock time · Day {day}</b>",
                     f"{e(MOCKS[day])}: Listening 30 min, Reading 60, Writing 60, Speaking 15.",
                     "Phone on silent. Type your scores in the Mocks tab when you finish."]
        else:
            lines = [f"<b>Evening block · Day {day}</b>",
                     "Listening section, then read the transcript and find why each answer was missed.",
                     "Then 20 minutes of grammar on one error type."]
    else:
        lines = [f"<b>Log Day {day}</b>",
                 "Tick your tasks, add hours, words and energy, and write one thing to fix tomorrow."]
        if day + 1 in MOCKS:
            lines.append(f"Tomorrow is a mock day: {e(MOCKS[day + 1])}. Sleep early.")
        if day == DAYS:
            lines.append("This was the last day of the challenge. Well done. Now rest before the exam.")
    return "\n".join(lines)


def send(text):
    token = os.environ.get("BOT_TOKEN", "").strip()
    chat = os.environ.get("CHAT_ID", "").strip()
    app = os.environ.get("APP_URL", "").strip()
    if not token or not chat:
        print(text)
        print("\n[dry run] BOT_TOKEN or CHAT_ID is missing, so nothing was sent.")
        return
    payload = {"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}
    if app:
        payload["reply_markup"] = json.dumps(
            {"inline_keyboard": [[{"text": "Open tracker", "web_app": {"url": app}}]]})
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                                 data=urllib.parse.urlencode(payload).encode())
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print("Sent:", r.status)
    except urllib.error.HTTPError as err:
        print("Telegram refused the message:", err.read().decode()[:300])
        sys.exit(1)


def main():
    slot = (sys.argv[1] if len(sys.argv) > 1 else "morning").strip() or "morning"
    if slot not in ("morning", "evening", "night"):
        sys.exit(f"Unknown reminder '{slot}'. Use morning, evening or night.")
    today = dt.datetime.now(TZ).date()
    day = (today - START).days + 1
    if not 1 <= day <= DAYS:
        print(f"Day {day} is outside the 60-day challenge, so no reminder today.")
        return
    word = None
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "daily.json"), encoding="utf-8") as f:
            word = json.load(f)[day - 1]
    except (OSError, ValueError, IndexError):
        pass
    send(build(slot, day, today, word))


if __name__ == "__main__":
    main()
