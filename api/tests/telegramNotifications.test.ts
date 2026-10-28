import { describe, expect, it } from "vitest";
import {
  formatTelegramDigest,
  selectTelegramNotificationItems,
  type NotificationMatch,
  type NotificationSource,
} from "../src/lib/telegramNotifications.js";

const matches: NotificationMatch[] = [
  { id: "m1", opportunity_source_id: "s1", match_score: 78, eligibility_status: "unknown", inbox_status: "new", created_at: "2026-10-28T00:00:00Z" },
  { id: "m2", opportunity_source_id: "s1", match_score: 84, eligibility_status: "eligible", inbox_status: "new", created_at: "2026-10-28T00:00:00Z" },
  { id: "m3", opportunity_source_id: "s2", match_score: 91, eligibility_status: "ineligible", inbox_status: "new", created_at: "2026-10-28T00:00:00Z" },
  { id: "m4", opportunity_source_id: "s3", match_score: 49, eligibility_status: "eligible", inbox_status: "new", created_at: "2026-10-28T00:00:00Z" },
  { id: "m5", opportunity_source_id: "s4", match_score: 88, eligibility_status: "eligible", inbox_status: "saved", created_at: "2026-10-28T00:00:00Z" },
  { id: "m6", opportunity_source_id: "s5", match_score: 89, eligibility_status: "eligible", inbox_status: "new", created_at: "2026-10-28T00:00:00Z" },
  { id: "m7", opportunity_source_id: "s6", match_score: 72, eligibility_status: "eligible", inbox_status: "new", created_at: "2026-10-28T00:00:00Z" },
];

const sources: NotificationSource[] = [
  { id: "s1", title: "Backend Intern", company: "Acme", location: "Remote", employment_type: "internship", application_url: "https://jobs.example.com/1", deadline_date: null, status: "active" },
  { id: "s2", title: "Data Intern", company: "Beta", location: null, employment_type: "internship", application_url: "https://jobs.example.com/2", deadline_date: null, status: "active" },
  { id: "s3", title: "QA Intern", company: "Gamma", location: "Pune", employment_type: "internship", application_url: "https://jobs.example.com/3", deadline_date: null, status: "active" },
  { id: "s4", title: "Saved Intern", company: "Delta", location: "Remote", employment_type: "internship", application_url: "https://jobs.example.com/4", deadline_date: null, status: "active" },
  { id: "s5", title: "Already Sent", company: "Epsilon", location: "Remote", employment_type: "internship", application_url: "https://jobs.example.com/5", deadline_date: null, status: "active" },
  { id: "s6", title: "No URL", company: "Zeta", location: null, employment_type: "internship", application_url: "javascript:alert(1)", deadline_date: null, status: "active" },
];

describe("selectTelegramNotificationItems", () => {
  it("keeps only new, high-scoring, non-ineligible active postings with safe application URLs", () => {
    const result = selectTelegramNotificationItems(matches, sources, new Set(["s5"]), 60, 10);
    expect(result.items.map((item) => item.sourceId)).toEqual(["s1"]);
    expect(result.items[0].matchId).toBe("m2");
    expect(result.items[0].eligibilityStatus).toBe("eligible");
    expect(result.omittedCount).toBe(0);
  });

  it("does not label unknown eligibility as confirmed eligibility", () => {
    const result = selectTelegramNotificationItems(
      [matches[0]],
      [sources[0]],
      new Set(),
      60,
      10
    );
    expect(result.items[0].eligibilityStatus).toBe("unknown");
    expect(formatTelegramDigest(result.items)).toContain("Eligibility unknown");
  });

  it("limits digest size and reports omitted matches", () => {
    const manyMatches: NotificationMatch[] = [
      { id: "a", opportunity_source_id: "s1", match_score: 80, eligibility_status: "eligible", inbox_status: "new", created_at: "2026-10-28T00:00:00Z" },
      { id: "b", opportunity_source_id: "s2", match_score: 70, eligibility_status: "eligible", inbox_status: "new", created_at: "2026-10-28T00:00:00Z" },
    ];
    const result = selectTelegramNotificationItems(manyMatches, sources, new Set(), 60, 1);
    expect(result.items).toHaveLength(1);
    expect(result.omittedCount).toBe(1);
    expect(formatTelegramDigest(result.items, result.omittedCount)).toContain("+1 more match");
  });
});
