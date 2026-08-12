// schemas.ts
// Request validation, deliberately separated from route handlers so it can
// be unit tested with no network/Supabase dependency (see tests/schemas.test.ts).

import { z } from "zod";

export const SignupRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "password must be at least 8 characters"),
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

// Mirrors personal_info's NOT NULL / check constraints from
// 0003_personal_info.sql — validated at the API boundary too, so a bad
// request fails fast with a clear message instead of a raw Postgres error.
export const PersonalInfoRequestSchema = z.object({
  legal_first_name: z.string().min(1),
  legal_last_name: z.string().min(1),
  preferred_name: z.string().optional(),
  email: z.string().email(),
  phone: z.string().optional(),
  location_city: z.string().optional(),
  location_country: z.string().min(1),
  pronouns: z.string().optional(),
});
export type PersonalInfoRequest = z.infer<typeof PersonalInfoRequestSchema>;

// consent_type mirrors the check constraint in 0004_consent_record.sql.
export const ConsentRequestSchema = z.object({
  consent_type: z.enum([
    "data_processing",
    "github_oauth_access",
    "llm_processing",
    "document_upload_storage",
  ]),
});
export type ConsentRequest = z.infer<typeof ConsentRequestSchema>;
