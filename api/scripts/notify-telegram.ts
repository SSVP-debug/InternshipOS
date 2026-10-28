// notify-telegram.ts
//
// Personal MVP notifier. Sends a daily digest for ONE candidate to ONE
// configured Telegram chat. The scheduled pipeline matches all candidates,
// but this script explicitly filters to TELEGRAM_CANDIDATE_ID; never point
// a shared TELEGRAM_CHAT_ID at every candidate. A multi-user product needs
// per-candidate Telegram linking, consent, and delivery preferences.
//
// Required when enabled:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_CANDIDATE_ID
//
// Optional:
//   TELEGRAM_MIN_MATCH_SCORE (default 60, range 0-100)
//   TELEGRAM_LOOKBACK_HOURS (default 36, range 1-168)
//   TELEGRAM_MAX_MATCHES (default 5, range 1-10)
//
// If all TELEGRAM_* credentials are absent, this exits successfully so the
// existing daily pipeline can run without notification configuration. A
// partially configured Telegram integration fails loudly.

import { createClient } from "@supabase/supabase-js";
import {
  formatTelegramDigest,
  selectTelegramNotificationItems,
  type NotificationMatch,
  type NotificationSource,
} from "../src/lib/telegramNotifications.js";

const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
const candidateId = process.env.TELEGRAM_CANDIDATE_ID?.trim() ?? "";
const telegramConfigCount = [botToken, chatId, candidateId].filter(Boolean).length;

if (telegramConfigCount === 0) {
  console.log("Telegram notifications are not configured; skipping notifier.");
  process.exit(0);
}

if (telegramConfigCount !== 3) {
  console.error(
    "Telegram notifications are partially configured. Set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and TELEGRAM_CANDIDATE_ID together."
  );
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Telegram notifier requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidateId)) {
  console.error("TELEGRAM_CANDIDATE_ID must be a candidate UUID from public.candidate.id.");
  process.exit(1);
}

function readNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}.`);
  }
  return parsed;
}

async function sendTelegramMessage(text: string): Promise<void> {
  // Do not log the request URL: Telegram's bot token is part of that URL.
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  let payload: { ok?: boolean } | null = null;
  try {
    payload = (await response.json()) as { ok?: boolean };
  } catch {
    // Treat an invalid response body as a delivery failure without logging it.
  }

  if (!response.ok || payload?.ok !== true) {
    // Deliberately omit Telegram's response body and request URL; neither is
    // needed for diagnostics, and the request URL contains the bot token.
    throw new Error(`Telegram sendMessage failed (HTTP ${response.status}). Check bot token, chat ID, and that the user has started the bot.`);
  }
}

async function main(): Promise<void> {
  const minScore = readNumberEnv("TELEGRAM_MIN_MATCH_SCORE", 60, 0, 100);
  const lookbackHours = readNumberEnv("TELEGRAM_LOOKBACK_HOURS", 36, 1, 168);
  const maxMatches = readNumberEnv("TELEGRAM_MAX_MATCHES", 5, 1, 10);
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  const supabase = createClient(supabaseUrl as string, serviceRoleKey as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: matchRows, error: matchError } = await supabase
    .from("opportunity_match")
    .select("id, opportunity_source_id, match_score, eligibility_status, inbox_status, created_at")
    .eq("candidate_id", candidateId)
    .eq("inbox_status", "new")
    .gte("created_at", since)
    .gte("match_score", minScore)
    .neq("eligibility_status", "ineligible")
    .order("match_score", { ascending: false });

  if (matchError) throw new Error(`Could not load recent candidate matches: ${matchError.message}`);

  const matches = (matchRows ?? []).map((row) => ({
    ...row,
    match_score: Number(row.match_score),
  })) as NotificationMatch[];

  if (matches.length === 0) {
    console.log("No recent new matches meet the score and eligibility filters.");
    return;
  }

  const sourceIds = [...new Set(matches.map((match) => match.opportunity_source_id))];
  const { data: sourceRows, error: sourceError } = await supabase
    .from("opportunity_source")
    .select("id, title, company, location, employment_type, application_url, deadline_date, status")
    .in("id", sourceIds)
    .eq("status", "active");

  if (sourceError) throw new Error(`Could not load active internship listings: ${sourceError.message}`);

  const { data: deliveryRows, error: deliveryError } = await supabase
    .from("telegram_notification_delivery")
    .select("opportunity_source_id")
    .eq("candidate_id", candidateId)
    .in("opportunity_source_id", sourceIds);

  if (deliveryError) throw new Error(`Could not load Telegram delivery history: ${deliveryError.message}`);

  const deliveredIds = new Set((deliveryRows ?? []).map((row) => row.opportunity_source_id as string));
  const selection = selectTelegramNotificationItems(
    matches,
    (sourceRows ?? []) as NotificationSource[],
    deliveredIds,
    minScore,
    maxMatches
  );

  if (selection.items.length === 0) {
    console.log("No undelivered, active matches meet the notification filters.");
    return;
  }

  const message = formatTelegramDigest(selection.items, selection.omittedCount);
  await sendTelegramMessage(message);

  // Persist only after Telegram confirms acceptance. This prevents normal
  // reruns from resending the same postings. A process crash after Telegram
  // accepts the message but before this insert succeeds can still cause a
  // duplicate on retry; external delivery cannot be made exactly-once here.
  const { error: insertError } = await supabase.from("telegram_notification_delivery").insert(
    selection.items.map((item) => ({
      candidate_id: candidateId,
      opportunity_source_id: item.sourceId,
      opportunity_match_id: item.matchId,
      match_score: item.matchScore,
    }))
  );

  if (insertError) {
    throw new Error(
      `Telegram accepted the digest, but delivery history could not be saved: ${insertError.message}. A retry may resend these postings.`
    );
  }

  console.log(`Telegram digest sent: ${selection.items.length} posting(s); ${selection.omittedCount} additional match(es) omitted by the per-run cap.`);
}

main().catch((error) => {
  console.error("Telegram notification failed:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
