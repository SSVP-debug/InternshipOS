// api.ts
// A thin wrapper around the Express API from api/src/routes/*.ts. Every
// function here maps 1:1 to a route on the backend — no business logic
// lives here, matching how the backend itself keeps schemas/validation
// separate from route handlers. Every authenticated call attaches the
// caller's own Supabase access token as a Bearer header; the backend's
// requireAuth middleware + RLS (via req.supabase) is what actually
// enforces ownership — this file does not attempt to.

import { getAccessToken } from "./auth";

const BASE_URL = import.meta.env.VITE_API_BASE_URL;

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, options: RequestInit = {}, authRequired = true): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");

  if (authRequired) {
    const token = await getAccessToken();
    if (!token) throw new ApiError(401, "not_authenticated", "You need to sign in first.");
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: "invalid_response", message: text };
    }
  }

  if (!res.ok) {
    const errBody = (body ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(
      res.status,
      errBody.error ?? "unknown_error",
      errBody.message ?? errBody.error ?? `Request failed (${res.status})`,
      errBody.details,
    );
  }

  return body as T;
}

const get = <T>(path: string, authRequired = true) => request<T>(path, { method: "GET" }, authRequired);
const post = <T>(path: string, body?: unknown, authRequired = true) =>
  request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }, authRequired);
const put = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined });
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

// ── Signup (no auth) ──────────────────────────────────────────────────────
export const signup = (email: string, password: string) =>
  post<{ user_id: string; message: string }>("/signup", { email, password }, false);

// ── Profile / Consent ────────────────────────────────────────────────────
export interface Candidate {
  id: string;
  profile_status: string;
  created_at: string;
}
export interface PersonalInfo {
  legal_first_name: string;
  legal_last_name: string;
  preferred_name?: string;
  email: string;
  phone?: string;
  location_city?: string;
  location_country: string;
  pronouns?: string;
}
export const getProfile = () => get<{ candidate: Candidate; personal_info: PersonalInfo | null }>("/profile");
export const saveProfile = (data: PersonalInfo) => post<{ message: string }>("/profile", data);

export type ConsentType = "data_processing" | "github_oauth_access" | "llm_processing" | "document_upload_storage";
export interface ConsentRecord {
  consent_type: ConsentType;
  granted_at: string;
  revoked_at: string | null;
  version: string;
}
export const grantConsent = (consent_type: ConsentType) => post<{ message: string }>("/consent", { consent_type });
export const listConsents = () => get<{ consents: ConsentRecord[] }>("/consent").then((b) => b.consents);

// ── Generic candidate-fact CRUD (education/skill/project/experience/achievement/certification) ──
export interface CrudApi<T> {
  list: () => Promise<T[]>;
  create: (data: Partial<T>) => Promise<T>;
  update: (id: string, data: Partial<T>) => Promise<T>;
  remove: (id: string) => Promise<void>;
}

function makeCrud<T>(resourcePath: string, collectionKey: string, itemKey: string): CrudApi<T> {
  return {
    list: async () => {
      const body = (await get<Record<string, T[]>>(`/${resourcePath}`)) as Record<string, T[]>;
      return body[collectionKey];
    },
    create: async (data) => {
      const body = (await post<Record<string, T>>(`/${resourcePath}`, data)) as Record<string, T>;
      return body[itemKey];
    },
    update: async (id, data) => {
      const body = (await put<Record<string, T>>(`/${resourcePath}/${id}`, data)) as Record<string, T>;
      return body[itemKey];
    },
    remove: async (id) => {
      await del<void>(`/${resourcePath}/${id}`);
    },
  };
}

export interface Education {
  id: string;
  institution_name: string;
  institution_country: string;
  degree_type: string;
  major: string;
  minor?: string;
  gpa_value?: number;
  gpa_scale?: number;
  start_date: string;
  expected_graduation_date?: string;
  actual_graduation_date?: string;
  enrollment_status: string;
  is_primary: boolean;
}
export const educationApi = makeCrud<Education>("education", "education", "education");

export interface Skill {
  id: string;
  name: string;
  category: string;
  self_rating?: string;
  evidence_backed: boolean;
}
export const skillApi = makeCrud<Skill>("skills", "skills", "skill");

export interface Project {
  id: string;
  title: string;
  description: string;
  role?: string;
  team_size?: number;
  start_date?: string;
  end_date?: string;
  is_ongoing: boolean;
  tech_stack: string[];
  external_url?: string;
}
export const projectApi = makeCrud<Project>("projects", "projects", "project");

export interface Experience {
  id: string;
  organization: string;
  title: string;
  employment_type: string;
  start_date: string;
  end_date?: string;
  is_current: boolean;
  location?: string;
  description_raw: string;
}
export const experienceApi = makeCrud<Experience>("experiences", "experiences", "experience");

export interface Achievement {
  id: string;
  title: string;
  issuing_body?: string;
  date_awarded: string;
  rank_or_result?: string;
  verification_url?: string;
}
export const achievementApi = makeCrud<Achievement>("achievements", "achievements", "achievement");

export interface Certification {
  id: string;
  name: string;
  issuer: string;
  issue_date: string;
  expiry_date?: string;
  credential_id?: string;
  verification_url?: string;
}
export const certificationApi = makeCrud<Certification>("certifications", "certifications", "certification");

// work_authorization is a singleton (one row per candidate, no :id in the route).
export interface WorkAuthorization {
  citizenship_country: string;
  status: string;
  requires_sponsorship: boolean;
  work_auth_expiry_date?: string;
  notes?: string;
}
export const getWorkAuthorization = () =>
  get<{ work_authorization: WorkAuthorization | null }>("/work-authorization");
export const saveWorkAuthorization = (data: WorkAuthorization) =>
  post<{ work_authorization: WorkAuthorization }>("/work-authorization", data);
export const updateWorkAuthorization = (data: WorkAuthorization) =>
  put<{ work_authorization: WorkAuthorization }>("/work-authorization", data);

// ── Evidence sources + Claims (Truth Layer) ──────────────────────────────
export interface EvidenceSource {
  id: string;
  source_type: "document_upload" | "github_repository";
  title: string;
  file_ref?: string;
  external_url?: string;
  owner_verified: boolean;
  created_at: string;
}
export const evidenceSourceApi = makeCrud<EvidenceSource>("evidence-sources", "evidence_sources", "evidence_source");

export type ClaimStatus = "DRAFT" | "CONFIRMED" | "DISPUTED" | "SUPERSEDED" | "REVOKED";
export interface Claim {
  id: string;
  subject_entity_type: string;
  subject_entity_id: string;
  claim_text: string;
  status: ClaimStatus;
  evidence_source_id?: string;
  superseded_by_claim_id?: string;
  last_reviewed_at?: string;
  created_at: string;
  updated_at: string;
}
export const listClaims = () => get<{ claims: Claim[] }>("/claims").then((b) => b.claims);
export const createClaim = (data: {
  subject_entity_type: string;
  subject_entity_id: string;
  claim_text: string;
  evidence_source_id?: string;
}) => post<{ claim: Claim }>("/claims", data).then((b) => b.claim);
export const setClaimStatus = (id: string, status: ClaimStatus) =>
  patch<{ claim: Claim }>(`/claims/${id}/status`, { status }).then((b) => b.claim);

export type TrustTier = "tier_1_verified" | "tier_2_document" | "tier_3_self_attested";
export interface TruthCenterEntry {
  claim_id: string;
  claim_text: string;
  status: ClaimStatus;
  subject_entity_type: string;
  subject_entity_id: string;
  subject_entity_name: string | null;
  subject_entity_label: string;
  trust_tier: TrustTier;
  trust_tier_label: string;
  trust_tier_explanation: string;
  evidence_summary: string;
  evidence_link: string | null;
  last_reviewed_at: string | null;
  used_in_applications_count: number;
  created_at: string;
}
export interface TruthCenterView {
  generated_at: string;
  claims_needing_review_count: number;
  // Keyed by subject_entity_type (e.g. "skill", "project", ...) — NOT an
  // array. Mirrors truth-center.ts's actual `groups: Record<string, ...>`
  // response shape exactly.
  groups: Record<string, TruthCenterEntry[]>;
}
export const getTruthCenter = () => get<TruthCenterView>("/truth-center");

// ── Account (export / delete) ────────────────────────────────────────────
export const exportAccount = () => get<Record<string, unknown>>("/export");
export const deleteAccount = () => del<void>("/account");

// ── Opportunity (Phase 1) ────────────────────────────────────────────────
export interface Opportunity {
  id: string;
  title: string;
  company: string;
  description?: string;
  location?: string;
  work_mode?: "remote" | "hybrid" | "onsite";
  employment_type: string;
  skills: string[];
  application_url?: string;
  source: string;
  deadline_date?: string;
  posted_date?: string;
  inbox_status: "new" | "saved" | "dismissed";
  is_priority: boolean;
  created_at: string;
  updated_at: string;
}
export const listOpportunities = (params?: { includeDismissed?: boolean; inboxStatus?: string }) => {
  const qs = new URLSearchParams();
  if (params?.includeDismissed) qs.set("include_dismissed", "true");
  if (params?.inboxStatus) qs.set("inbox_status", params.inboxStatus);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return get<{ opportunities: Opportunity[] }>(`/opportunities${suffix}`).then((b) => b.opportunities);
};
export const getOpportunity = (id: string) => get<{ opportunity: Opportunity }>(`/opportunities/${id}`).then((b) => b.opportunity);
export const createOpportunity = (data: Partial<Opportunity>) =>
  post<{ opportunity: Opportunity }>("/opportunities", data).then((b) => b.opportunity);
export const updateOpportunity = (id: string, data: Partial<Opportunity>) =>
  put<{ opportunity: Opportunity }>(`/opportunities/${id}`, data).then((b) => b.opportunity);
export const updateOpportunityInbox = (id: string, data: { inbox_status?: string; is_priority?: boolean }) =>
  patch<{ opportunity: Opportunity }>(`/opportunities/${id}/inbox`, data).then((b) => b.opportunity);
export const deleteOpportunity = (id: string) => del<void>(`/opportunities/${id}`);

// ── Application (Phase 1) ────────────────────────────────────────────────
export type ApplicationStatus =
  | "SAVED"
  | "APPLYING"
  | "APPLIED"
  | "ASSESSMENT"
  | "INTERVIEW"
  | "OFFER"
  | "REJECTED"
  | "WITHDRAWN";

export interface OpportunitySummary {
  id: string;
  title: string;
  company: string;
  location?: string;
  work_mode?: string;
  application_url?: string;
  deadline_date?: string;
}
export interface Application {
  id: string;
  opportunity_id: string;
  status: ApplicationStatus;
  applied_at?: string;
  deadline_override?: string;
  next_action_date?: string;
  next_action_note?: string;
  recruiter_name?: string;
  recruiter_email?: string;
  created_at: string;
  updated_at: string;
  opportunity?: OpportunitySummary | null;
}
export interface ApplicationStatusEvent {
  id: string;
  from_status: string | null;
  to_status: string;
  note?: string;
  created_at: string;
}
export interface ApplicationNote {
  id: string;
  note_type: "general" | "recruiter_contact" | "interview" | "next_action" | "link";
  content: string;
  created_at: string;
  updated_at: string;
}
export const listApplications = (status?: ApplicationStatus) => {
  const suffix = status ? `?status=${status}` : "";
  return get<{ applications: Application[] }>(`/applications${suffix}`).then((b) => b.applications);
};
export const getApplication = (id: string) =>
  get<{ application: Application; status_history: ApplicationStatusEvent[]; notes: ApplicationNote[] }>(
    `/applications/${id}`,
  );
export const createApplication = (data: {
  opportunity_id: string;
  deadline_override?: string;
  next_action_date?: string;
  next_action_note?: string;
  recruiter_name?: string;
  recruiter_email?: string;
}) => post<{ application: Application }>("/applications", data).then((b) => b.application);
export const updateApplication = (id: string, data: Partial<Application>) =>
  put<{ application: Application }>(`/applications/${id}`, data).then((b) => b.application);
export const setApplicationStatus = (id: string, status: ApplicationStatus, note?: string) =>
  patch<{ application: Application }>(`/applications/${id}/status`, { status, note }).then((b) => b.application);

export const listApplicationNotes = (applicationId: string) =>
  get<{ notes: ApplicationNote[] }>(`/applications/${applicationId}/notes`).then((b) => b.notes);
export const addApplicationNote = (
  applicationId: string,
  data: { note_type: ApplicationNote["note_type"]; content: string },
) => post<{ note: ApplicationNote }>(`/applications/${applicationId}/notes`, data).then((b) => b.note);
export const updateApplicationNote = (id: string, data: { note_type?: ApplicationNote["note_type"]; content: string }) =>
  put<{ note: ApplicationNote }>(`/application-notes/${id}`, data).then((b) => b.note);
export const deleteApplicationNote = (id: string) => del<void>(`/application-notes/${id}`);

// ── Today dashboard (Phase 1) ────────────────────────────────────────────
export interface TodayActionItem {
  application_id: string;
  opportunity_id: string;
  title: string;
  company: string;
  reason: "deadline_approaching" | "follow_up_due" | "follow_up_overdue";
  due_date: string;
  days_until_due: number;
}
export interface TodaySavedOpportunity {
  opportunity_id: string;
  title: string;
  company: string;
  application_url: string | null;
  deadline_date: string | null;
  is_priority: boolean;
}
export interface TodayRecentlyApplied {
  application_id: string;
  opportunity_id: string;
  title: string;
  company: string;
  applied_at: string;
}
export interface TodayFeedHighlight {
  opportunity_match_id: string;
  title: string;
  company: string;
  match_score: number;
  eligibility_status: "eligible" | "ineligible" | "unknown";
}
export interface TodayFeedSummary {
  new_matches_count: number;
  top_matches: TodayFeedHighlight[];
}
export interface TodayView {
  generated_at: string;
  action_required: TodayActionItem[];
  deadlines_approaching: TodayActionItem[];
  follow_ups_due: TodayActionItem[];
  saved_opportunities: TodaySavedOpportunity[];
  recently_applied: TodayRecentlyApplied[];
  pipeline_summary: Record<string, number>;
  feed_summary: TodayFeedSummary;
  stats: {
    total_applications: number;
    active_applications: number;
    opportunities_needing_triage: number;
    overdue_follow_ups_count: number;
    deadlines_next_7_days_count: number;
  };
}
export const getToday = () => get<TodayView>("/today");

// ── Opportunity Feed (Phase 2B) ──────────────────────────────────────────
// Read/aggregation layer over opportunity_source + opportunity_match — a
// DIFFERENT concept from the Opportunity (Phase 1) inbox above: these
// items come from the auto-ingested catalog + the candidate's own
// matchEngine.ts scores, not from anything the candidate typed in
// manually. Save/dismiss/priority live on opportunity_match here, mirror
// of the same three fields on Opportunity above.
export interface OpportunityFeedItem {
  opportunity_match_id: string;
  opportunity_source_id: string;
  title: string;
  company: string;
  location: string | null;
  work_mode: string | null;
  employment_type: string;
  posted_date: string | null;
  application_url: string | null;
  match_score: number;
  eligibility_status: "eligible" | "ineligible" | "unknown";
  match_reasons: string[];
  match_missing: string[];
  match_unknown: string[];
  inbox_status: "new" | "saved" | "dismissed";
  is_priority: boolean;
  // Set once the candidate has used the Apply button to turn this match
  // into a tracked application (see updateOpportunityMatchInbox below and
  // the Apply flow in pages/opportunityFeed.ts). Null until then.
  promoted_opportunity_id: string | null;
}
export interface OpportunityFeedView {
  generated_at: string;
  items: OpportunityFeedItem[];
}
export const getOpportunityFeed = () => get<OpportunityFeedView>("/opportunity-feed");

// PATCH /opportunity-matches/:id/inbox returns the raw opportunity_match
// row (same columns the GET route selects), NOT a full OpportunityFeedItem
// — it has no title/company/location/etc. and match_breakdown is the raw
// jsonb column rather than the unpacked reasons/missing/unknown arrays.
// Callers should merge inbox_status/is_priority back into their existing
// feed item rather than treating this as a replacement item.
export interface OpportunityMatchRecord {
  id: string;
  opportunity_source_id: string;
  match_score: number;
  eligibility_status: "eligible" | "ineligible" | "unknown";
  match_breakdown: unknown;
  inbox_status: "new" | "saved" | "dismissed";
  is_priority: boolean;
  promoted_opportunity_id: string | null;
}
export const updateOpportunityMatchInbox = (
  matchId: string,
  data: {
    inbox_status?: OpportunityFeedItem["inbox_status"];
    is_priority?: boolean;
    // Sent once, right after the Apply flow creates the candidate-owned
    // opportunity/application rows for this match — the backend verifies
    // (via RLS, see opportunity-feed.ts's route) that the referenced
    // opportunity actually belongs to the caller before accepting it.
    promoted_opportunity_id?: string;
  },
) =>
  patch<{ opportunity_match: OpportunityMatchRecord }>(`/opportunity-matches/${matchId}/inbox`, data).then(
    (b) => b.opportunity_match,
  );
