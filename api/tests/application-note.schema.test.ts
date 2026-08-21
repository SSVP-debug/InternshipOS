import { describe, it, expect } from "vitest";
import { ApplicationNoteRequestSchema } from "../src/lib/schemas.js";

describe("ApplicationNoteRequestSchema", () => {
  it("accepts a minimal valid record (content only), defaults note_type to general", () => {
    const result = ApplicationNoteRequestSchema.safeParse({ content: "Recruiter called back." });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.note_type).toBe("general");
  });

  it("accepts each of the five defined note_type values", () => {
    const types = ["general", "recruiter_contact", "interview", "next_action", "link"];
    for (const note_type of types) {
      const result = ApplicationNoteRequestSchema.safeParse({ note_type, content: "x" });
      expect(result.success, `expected note_type ${note_type} to be accepted`).toBe(true);
    }
  });

  it("rejects an invalid note_type", () => {
    const result = ApplicationNoteRequestSchema.safeParse({ note_type: "gossip", content: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects blank content", () => {
    const result = ApplicationNoteRequestSchema.safeParse({ content: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects a missing content field", () => {
    const result = ApplicationNoteRequestSchema.safeParse({ note_type: "link" });
    expect(result.success).toBe(false);
  });

  it("trims content", () => {
    const result = ApplicationNoteRequestSchema.safeParse({ content: "  Trimmed note.  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.content).toBe("Trimmed note.");
  });
});
