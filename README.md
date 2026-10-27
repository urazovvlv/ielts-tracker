# ielts-tracker

A Telegram Mini App for IELTS preparation: daily checklist, weekly exercises, mock scores, words with flashcards, a Speaking Part 2 timer, and bot reminders three times a day.

## Several people, one bot

Each person opens the app from their own Telegram account. Their plan (Day 1, exam date, target band) and all their progress are saved in **their** Telegram account, so nobody sees anyone else's tracker. No login or password is needed.

## Reminders for everyone

The reminders follow each person's own plan. To add someone:

1. They press **Start** in the bot chat, open the app, and set up their plan.
2. In the app: ⚙️ Settings → **Copy reminder code**, and they send the code to the bot owner.
3. The bot owner adds the codes to the `USERS` secret (Settings → Secrets and variables → Actions) as a list:

```json
[{"id":111,"name":"Xushnud","start":"2026-10-19","exam":"","days":60,"target":7.5},
 {"id":222,"name":"Ali","start":"2026-10-27","exam":"2026-12-20","days":54,"target":7}]
```

`CHAT_ID` from the first setup still works and uses the original 60-day plan (Day 1 = 19 Oct 2026), unless the same ID is listed in `USERS`. Send a new code whenever a plan changes.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The mini app |
| `daily.json` | One IELTS collocation per day, with Uzbek meaning and an example |
| `reminders.py` | Sends the reminders (same schedule rules as the app) |
| `.github/workflows/reminders.yml` | Runs the reminders at about 06:40, 19:15 and 21:15 Tashkent time |

Never put the bot token in a file. It goes only in the `BOT_TOKEN` secret.

## Updating the app

Telegram caches the page. When you change `index.html`, also change `BUILD` near the top of its script and put the same value in `version.json`. Open copies then reload themselves once with the new version.

## Today's focus (optional Cloudflare Worker)

The 07:00 message names the skill with the most tasks on today's list. The bot can't read the app's storage, so the app sends only the skill counts (L/R/W/S/Voc per day) to a small free Cloudflare Worker: `worker/worker.js`.

1. Cloudflare → Workers & Pages → Create Worker, paste `worker/worker.js`, deploy.
2. Storage → KV → create a namespace; in the Worker's Settings → Bindings add it as `FOCUS`.
3. Worker Settings → Variables and Secrets: secrets `BOT_TOKEN` (same as GitHub) and `READ_KEY` (any long random text).
4. Put the Worker address in `WORKER_URL` in `index.html` (bump BUILD + version.json).
5. GitHub secrets: `FOCUS_URL` (the Worker address) and `READ_KEY` (same text).

Without it the morning message is sent without the focus line.
