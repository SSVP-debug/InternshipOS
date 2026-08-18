# Data Retention & Inactivity Policy — DRAFT (pending your sign-off)

**Status:** Draft — proposed defaults below, not yet approved. This is the
one Phase 0 item the architecture doc (`candidate-truth-layer-phase0.md`,
Day 6/7) calls a real gap if left unwritten. Nothing here is implemented in
code yet; this is the policy that the retention job (not yet built) will
enforce once approved.

This is distinct from **account deletion** (`DELETE /account`), which is
immediate, hard, and cascading, and is already built and validated. This
document governs what happens to an account the *student never explicitly
deletes* but also stops using.

---

## 1. Definitions

- **Inactive**: no authenticated request (login, profile edit, claim
  confirmation, export, etc.) for the configured inactivity window.
- **Notice period**: the window between a "your account will be archived"
  notice and the archival/deletion action actually taking effect.
- **Archived** (distinct from deleted): account and data become
  inaccessible via the API and excluded from any future matching/AI
  features, but rows are retained internally for the archival retention
  window below — not yet purged. This gives a lapsed student a recovery
  path without silently keeping them "active" forever.

## 2. Proposed windows (defaults — please confirm or adjust)

| Stage | Proposed window | Trigger | Action |
|---|---|---|---|
| Inactivity → warning | **365 days** since last authenticated activity | Scheduled job | Email notice sent to the account's registered address; account flagged `pending_archival` |
| Warning → archival | **30 days** after the warning, if still inactive | Scheduled job | Account and all Phase-0 data moved to `archived` state (API access blocked; data retained, not purged) |
| Archived → hard deletion | **180 days** after archival | Scheduled job | Full cascading deletion, identical in effect to a manual `DELETE /account` |

**Reasoning for defaults:** 365 days covers a full academic year plus a
gap year without falsely flagging a student who's just between semesters;
the 30-day warning window mirrors common SaaS practice and gives real
reaction time; the 180-day archived window gives a genuine recovery path
before anything is unrecoverable. **These are placeholder defaults based
on common practice, not a legal or product requirement — please confirm
the actual numbers you want**, especially if there's an institutional
(school-partnership) policy this needs to match later.

## 3. What happens at each stage, concretely

- **At the warning stage**: one email notice, no in-product nagging beyond
  that. No account behavior changes yet — the student can log in and use
  the product normally, and doing so cancels the pending archival.
- **At archival**: `candidate.status` (a new column, not yet in the
  schema — see §5) is set to `archived`. RLS continues to allow the
  candidate to log in and either export their data or explicitly delete
  the account, but blocks all other writes. This is intentionally the one
  exception to "archived means inaccessible via the API" — a student must
  always be able to get their own data out or delete it, even archived.
- **At hard deletion**: identical cascade to the already-built and
  validated `DELETE /account` path (migration/test suite:
  `test_account_deletion_cascade.sql`) — no new deletion logic needed,
  the retention job simply calls the same path programmatically instead
  of a student calling it manually.

## 4. Consent copy (student-facing, shown at signup alongside the existing `data_processing` consent)

> **Draft language — not yet reviewed for legal accuracy:**
> "If you don't use InternshipOS for 12 months, we'll email you a notice.
> If your account is still inactive 30 days after that notice, we'll
> archive it — your data stays retained but the account becomes
> inaccessible for anything beyond exporting or deleting it. After 180
> days in archived state, your data is permanently deleted. You can
> export or delete your data at any time, no matter what state your
> account is in."

**[Knowledge Gap]** This copy has not been reviewed by anyone with legal
or compliance expertise. Given the education-sector context, a review
against FERPA (and any applicable state student-privacy law) is
recommended before this ships to real users — flagged here rather than
silently assumed handled.

## 5. Implementation gap this creates (not yet built)

Approving this policy is a prerequisite for building the retention job,
not the job itself. Once approved, the following code work remains
(tracked in `PROGRESS.md`, not done as part of this document):

- A `status` column on `candidate` (`active | pending_archival | archived`)
  with a migration and matching RLS policy updates (archived candidates
  keep read/export/delete-only access, per §3).
- A scheduled job (cron, or Supabase's scheduled functions) that runs the
  three transitions above.
- Email delivery for the warning notice (no email-sending integration
  exists in the codebase today — this is a new external dependency).
- Reactivation logic: any authenticated action while `pending_archival`
  clears the flag; nothing currently defines whether — or how — an
  `archived` account can be reactivated versus needing the student to
  sign up fresh. **This needs your decision too**, not assumed.

---

## Sign-off

- [ ] Windows in §2 approved as-is, or adjusted to: ______________
- [ ] Consent copy in §4 approved as draft language, pending legal review
- [ ] Reactivation policy for archived accounts decided: ______________

Until these are checked off, this remains a draft and no retention job
should be built against it.
