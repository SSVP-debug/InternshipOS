import { describe, it, expect } from "vitest";
import { EvidenceSourceRequestSchema } from "../src/lib/schemas.js";

describe("EvidenceSourceRequestSchema — valid data", () => {
  it("accepts a valid document_upload", () => {
    const result = EvidenceSourceRequestSchema.safeParse({
      source_type: "document_upload",
      title: "Resume.pdf",
      file_ref: "uploads/candidate-123/resume.pdf",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid github_repository", () => {
    const result = EvidenceSourceRequestSchema.safeParse({
      source_type: "github_repository",
      title: "InternshipOS",
      external_url: "https://github.com/example/internshipos",
    });
    expect(result.success).toBe(true);
  });

  it("trims surrounding whitespace from title", () => {
    const result = EvidenceSourceRequestSchema.safeParse({
      source_type: "document_upload",
      title: "  Transcript  ",
      file_ref: "uploads/transcript.pdf",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe("Transcript");
  });
});

describe("EvidenceSourceRequestSchema — validation failures", () => {
  it("rejects an empty title", () => {
    const result = EvidenceSourceRequestSchema.safeParse({
      source_type: "document_upload",
      title: "",
      file_ref: "uploads/resume.pdf",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized source_type", () => {
    const result = EvidenceSourceRequestSchema.safeParse({
      source_type: "linkedin_profile",
      title: "LinkedIn",
      external_url: "https://linkedin.com/in/example",
    });
    expect(result.success).toBe(false);
  });

  it("rejects document_upload with external_url instead of file_ref", () => {
    const result = EvidenceSourceRequestSchema.safeParse({
      source_type: "document_upload",
      title: "Resume",
      external_url: "https://example.com/resume.pdf",
    });
    expect(result.success).toBe(false);
  });

  it("rejects github_repository with file_ref instead of external_url", () => {
    const result = EvidenceSourceRequestSchema.safeParse({
      source_type: "github_repository",
      title: "InternshipOS",
      file_ref: "uploads/repo.txt",
    });
    expect(result.success).toBe(false);
  });

  it("rejects document_upload with BOTH file_ref and external_url set", () => {
    const result = EvidenceSourceRequestSchema.safeParse({
      source_type: "document_upload",
      title: "Resume",
      file_ref: "uploads/resume.pdf",
      external_url: "https://example.com/resume.pdf",
    });
    expect(result.success).toBe(false);
  });

  it("rejects document_upload with neither file_ref nor external_url", () => {
    const result = EvidenceSourceRequestSchema.safeParse({
      source_type: "document_upload",
      title: "Resume",
    });
    expect(result.success).toBe(false);
  });

  it("never has an owner_verified field — it is settable only by the GitHub OAuth flow, not this API", () => {
    // EvidenceSourceRequestSchema is wrapped in .refine() (ZodEffects), so
    // .shape isn't directly reachable — same situation as
    // ProjectRequestSchema (see project.schema.test.ts). Verify instead
    // that a caller-supplied owner_verified is silently stripped and never
    // surfaces in the parsed, persisted data.
    const result = EvidenceSourceRequestSchema.safeParse({
      source_type: "document_upload",
      title: "Resume",
      file_ref: "uploads/resume.pdf",
      owner_verified: true,
    } as unknown as Record<string, unknown>);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.owner_verified).toBeUndefined();
    }
  });
});
