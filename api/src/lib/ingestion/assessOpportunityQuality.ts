/**
 * Deterministic opportunity quality assessment.
 *
 * This is a REVIEW signal, not a deletion/filtering decision. Every listing
 * remains in opportunity_source; suspicious listings are labeled for the
 * dashboard and downstream ranking. A signal is never proof of fraud.
 */

export type QualityStatus = "clear" | "review" | "high_risk";

export interface QualityAssessment {
  quality_status: QualityStatus;
  quality_score: number;
  quality_flags: string[];
}

const FEE_PATTERNS: RegExp[] = [
  /\b(?:registration|application|processing|training|security|interview)\s+fee\b/i,
  /\bpay\s+(?:a\s+)?(?:fee|deposit|charge)\b/i,
  /\b(?:fee|deposit)\s+(?:is\s+)?required\b/i,
  /\brefundable\s+(?:registration|security|training)\s+fee\b/i,
];

const PRESSURE_PATTERNS: RegExp[] = [
  /\bpay\s+today\b/i,
  /\bwithin\s+\d+\s+hours?\b/i,
  /\blimited\s+slots?\s+only\b/i,
  /\bguaranteed\s+(?:job|internship|placement)\s+after\s+payment\b/i,
];

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "proton.me", "protonmail.com", "rediffmail.com",
]);

function extractEmails(text: string): string[] {
  return [...text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)]
    .map((match) => match[1].toLowerCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function assessOpportunityQuality(input: {
  title: string;
  company: string;
  description: string | null;
  sourceUrl: string | null;
  applicationUrl: string | null;
}): QualityAssessment {
  const text = [input.title, input.company, input.description ?? ""].join("\n");
  const flags: string[] = [];

  if (FEE_PATTERNS.some((pattern) => pattern.test(text))) {
    flags.push("fee_request_language");
  }

  if (/\b(?:contact|message|send\s+(?:your\s+)?resume)\s+(?:us\s+)?on\s+whatsapp\b/i.test(text) ||
      /\bwhatsapp\s+(?:only|preferred|for\s+application)\b/i.test(text)) {
    flags.push("whatsapp_only_contact");
  }

  const emailDomains = unique(extractEmails(text));
  if (emailDomains.some((domain) => FREE_MAIL_DOMAINS.has(domain))) {
    flags.push("free_mail_recruiter_contact");
  }

  if (PRESSURE_PATTERNS.some((pattern) => pattern.test(text))) {
    flags.push("urgency_or_payment_pressure");
  }

  if (!input.applicationUrl) flags.push("missing_application_url");
  if (!input.sourceUrl) flags.push("missing_source_url");

  const highRiskCount = flags.filter((flag) =>
    ["fee_request_language", "urgency_or_payment_pressure"].includes(flag)
  ).length;
  const reviewCount = flags.length - highRiskCount;

  const quality_status: QualityStatus =
    highRiskCount > 0 ? "high_risk" : reviewCount > 0 ? "review" : "clear";

  // Transparent deterministic score: high-risk signals carry more weight.
  const quality_score = Math.max(0, 100 - highRiskCount * 45 - reviewCount * 10);

  return {
    quality_status,
    quality_score,
    quality_flags: flags,
  };
}
