# Step 2 — Opportunity quality signals

## Scope

Step 2 adds deterministic quality labels to every ingested opportunity. It
does not delete, suppress, or silently discard listings. The database retains
clear, review, high-risk, ineligible, and expired records with their labels.

## Initial signals

- `fee_request_language`: explicit registration/application/processing/
  training/security fee language.
- `whatsapp_only_contact`: wording that directs applicants to WhatsApp only.
- `free_mail_recruiter_contact`: recruiter contact address on a known
  consumer email domain.
- `urgency_or_payment_pressure`: explicit payment urgency or guaranteed
  placement after payment.
- `missing_application_url` and `missing_source_url`: traceability gaps.

Free-mail and WhatsApp signals are review warnings, not automatic scam
verdicts. High-risk means inspect before applying; it is not a factual claim
that the employer is fraudulent.

## Score

Start at 100. Each high-risk signal subtracts 45 points; each review signal
subtracts 10 points. The result is clamped to 0–100. Status is high_risk when
a high-risk signal exists, review when only review signals exist, otherwise
clear. This score is independent of the candidate match score.

## Data model

Migration `0033_opportunity_quality_signals.sql` adds
`quality_status`, `quality_score`, and `quality_flags` to
`public.opportunity_source`. Defaults preserve existing rows as clear
until they are reprocessed by ingestion.
