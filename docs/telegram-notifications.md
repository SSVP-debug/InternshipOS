# Telegram match notifications

The first version is intentionally a **single-candidate personal MVP**: one configured candidate is sent a digest in one Telegram chat. The daily matching job still processes every active candidate, but the notifier filters to TELEGRAM_CANDIDATE_ID. Do not configure one shared chat to receive every candidate's matches. A public multi-user release needs per-candidate Telegram linking, consent, and preferences first.

## One-time setup

1. In Telegram, open @BotFather, create a bot, and copy its token.
2. Open the new bot chat and press **Start**. A bot cannot initiate a private conversation before the user starts it.
3. Obtain your Telegram chat ID using a trusted bot/getUpdates workflow. Treat the bot token as a password; never commit it or paste it into source code.
4. Find your own candidate UUID in Supabase SQL Editor. Replace the email/UUID filter with the identity you use to sign in:

   select id from public.candidate where auth_user_id = '<your auth.users UUID>';

   Use the returned candidate.id, not the auth.users.id.
5. In GitHub, open **Settings → Secrets and variables → Actions** and add these repository secrets:
   - TELEGRAM_BOT_TOKEN
   - TELEGRAM_CHAT_ID
   - TELEGRAM_CANDIDATE_ID
6. Optional repository variables:
   - TELEGRAM_MIN_MATCH_SCORE — defaults to 60 (0–100).
   - TELEGRAM_LOOKBACK_HOURS — defaults to 36 (1–168); controls how recently a match row must have been created.
   - TELEGRAM_MAX_MATCHES — defaults to 5 (1–10).

The existing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY secrets are also required. The service-role key stays inside GitHub Actions and must never be exposed to frontend code.

## Behavior and limits

- Sends only inbox_status = 'new' matches created within the lookback window and scoring at least the configured threshold.
- Excludes explicitly ineligible matches. Unknown eligibility can still be notified, but is labelled **“Eligibility unknown — verify before applying”** rather than being presented as confirmed.
- Requires an active listing with a valid HTTP(S) application URL.
- Sends one entry per posting, choosing the strongest candidate/resume match.
- Keeps a service-role-only delivery ledger so normal reruns do not resend previously delivered postings.
- Sends a maximum of five listings by default to keep the digest manageable.
- If all Telegram secrets are absent, the notifier skips cleanly. If only some are set, it fails clearly.
- The first run intentionally looks back only 36 hours by default; it does not dump the candidate's entire historical match feed into Telegram.
- Deduplication is best-effort. If Telegram accepts a message but the process crashes before the delivery ledger is written, a retry may send it again.
- Telegram/API failure happens after ingestion and matching; it does not undo their database writes. The workflow will show the notification step as failed so it is visible.

## Manual test

Use **Actions → Daily Opportunity Pipeline → Run workflow** after configuring the secrets. Check the run logs for the notifier summary; the bot token and chat ID are never printed. If there are no recent matches, the step reports that and exits successfully.
