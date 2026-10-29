# ielts-tracker

A Telegram Mini App for IELTS preparation: daily checklist, Daily pack (grammar + 6 × 10 items), Cambridge reading vocabulary and keyword tables (`books/`), words with spaced review, mock scores, Writing and Speaking practice, a mistake log, and bot reminders.

## Private

Only the Telegram accounts in `OWNER_IDS` (`index.html`) and `ALLOWED_IDS` (`wrangler.jsonc`) can use the app; everyone else sees "This tracker is private", and the Worker refuses their sync and sends them no reminders. Data is saved in the owner's own Telegram account.

## Reminders (Cloudflare Worker)

`worker/worker.js` runs on Cloudflare (free plan) and deploys from this repo automatically (Workers Builds, `wrangler.jsonc`, KV binding `FOCUS`). Its Cron Triggers send, in Tashkent time:

- 12:00 on Tuesday, Thursday and Saturday: Cambridge vocabulary day (the same task is added to that day's list)
- 07:00 morning message: day, days left, today's focus skill, mock day, Daily pack topics
- 19:15 evening check (mock instructions on mock days)
- 21:15 log reminder (and a note before mock days)
- 23:00 daily report (tasks done / not done) with a link to the daily survey, plus the weekly report on the last day of each plan week

The owner gets reminders for their plan: the app sends the Worker its plan, mock dates, per-day task counts by skill, today's and yesterday's task names with done marks, daily survey answers, mock scores and a small summary (no saved words or essays). Requests are checked against Telegram's `initData` signature.

Worker settings: secret `BOT_TOKEN` (same token as the bot). The GitHub workflow `reminders.yml` only sends a reminder by hand for testing; it needs the `BOT_TOKEN` GitHub secret.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The mini app |
| `daily/` | Daily packs (`01.json` …) and `index.json` with their count |
| `daily.json` | Word of the day |
| `speaking.json` | Speaking Part 1 topics and Part 3 questions |
| `worker/worker.js`, `wrangler.jsonc` | Cloudflare Worker: sync, reminders, weekly report |

Never put the bot token in a file. It goes only in secrets.

## Updating the app

Telegram caches the page. When you change `index.html`, also change `BUILD` near the top of its script and put the same value in `version.json`. Open copies then reload themselves once with the new version.
