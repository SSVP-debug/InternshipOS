export type NotificationMatch = {
  id: string;
  opportunity_source_id: string;
  match_score: number;
  eligibility_status: "eligible" | "ineligible" | "unknown";
  inbox_status: "new" | "saved" | "dismissed";
  created_at: string;
};

export type NotificationSource = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  employment_type: string;
  application_url: string | null;
  deadline_date: string | null;
  status: "active" | "expired" | "removed" | string;
};

export type TelegramNotificationItem = {
  matchId: string;
  sourceId: string;
  title: string;
  company: string;
  location: string | null;
  employmentType: string;
  applicationUrl: string;
  deadlineDate: string | null;
  matchScore: number;
  eligibilityStatus: "eligible" | "unknown";
};

function isHttpUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Selects one notification per posting, preferring the strongest resume-scoped
 * or candidate-level match. Explicitly ineligible, triaged, already-delivered,
 * inactive, and non-HTTP(S) listings are never sent.
 */
export function selectTelegramNotificationItems(
  matches: NotificationMatch[],
  sources: NotificationSource[],
  deliveredSourceIds: Set<string>,
  minScore: number,
  maxItems: number
): { items: TelegramNotificationItem[]; omittedCount: number } {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const bestBySource = new Map<string, TelegramNotificationItem>();

  for (const match of matches) {
    if (match.inbox_status !== "new") continue;
    if (match.eligibility_status === "ineligible") continue;
    if (!Number.isFinite(match.match_score) || match.match_score < minScore) continue;
    if (deliveredSourceIds.has(match.opportunity_source_id)) continue;

    const source = sourceById.get(match.opportunity_source_id);
    if (!source || source.status !== "active" || !isHttpUrl(source.application_url)) continue;

    const item: TelegramNotificationItem = {
      matchId: match.id,
      sourceId: source.id,
      title: source.title,
      company: source.company,
      location: source.location,
      employmentType: source.employment_type,
      applicationUrl: source.application_url,
      deadlineDate: source.deadline_date,
      matchScore: match.match_score,
      eligibilityStatus: match.eligibility_status,
    };

    const current = bestBySource.get(source.id);
    if (
      !current ||
      item.matchScore > current.matchScore ||
      (item.matchScore === current.matchScore &&
        item.eligibilityStatus === "eligible" &&
        current.eligibilityStatus === "unknown")
    ) {
      bestBySource.set(source.id, item);
    }
  }

  const sorted = Array.from(bestBySource.values()).sort(
    (a, b) => b.matchScore - a.matchScore || a.company.localeCompare(b.company) || a.title.localeCompare(b.title)
  );

  return {
    items: sorted.slice(0, maxItems),
    omittedCount: Math.max(0, sorted.length - maxItems),
  };
}

function cleanLine(value: string | null | undefined, maxLength = 100): string {
  const cleaned = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Not specified";
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength - 1) + "…" : cleaned;
}

/** Plain text only: no Telegram parse_mode, so untrusted listing text cannot inject markup. */
export function formatTelegramDigest(
  items: TelegramNotificationItem[],
  omittedCount = 0
): string {
  if (items.length === 0) return "InternshipOS: no new matches to notify.";

  const sections = items.map((item, index) => {
    const eligibility =
      item.eligibilityStatus === "eligible" ? "Eligible" : "Eligibility unknown — verify before applying";
    const lines = [
      \`\${index + 1}. \${cleanLine(item.title)} — \${cleanLine(item.company, 80)}\`,
      \`Match: \${Math.round(item.matchScore)}/100 | \${eligibility}\`,
      \`Location: \${cleanLine(item.location, 80)}\`,
      \`Type: \${cleanLine(item.employmentType, 40)}\`,
    ];
    if (item.deadlineDate) lines.push(\`Deadline: \${cleanLine(item.deadlineDate, 30)}\`);
    lines.push(\`Apply: \${item.applicationUrl}\`);
    return lines.join("\\n");
  });

  let message = \`InternshipOS — \${items.length} new match\${items.length === 1 ? "" : "es"}\\n\\n\${sections.join("\\n\\n")}\`;
  if (omittedCount > 0) {
    message += \`\\n\\n+\${omittedCount} more match(es) not included. Review InternshipOS for the rest.\`;
  }
  // Telegram's message limit is 4096 characters. Keep a margin for API-side
  // differences and avoid silently slicing a URL in the middle.
  if (message.length > 3900) {
    const trimmedItems = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
    return formatTelegramDigest(
      trimmedItems,
      omittedCount + items.length - trimmedItems.length
    );
  }
  return message;
}
