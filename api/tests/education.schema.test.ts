import { describe, it, expect } from "vitest";
import { EducationRequestSchema, UuidParamSchema } from "../src/lib/schemas.js";

const validBase = {
  institution_name: "State University",
  institution_country: "US",
  degree_type: "bachelor" as const,
  major: "Computer Science",
  start_date: "2023-08-15",
  enrollment_status: "current" as const,
};

describe("EducationRequestSchema — valid data", () => {
  it("accepts a minimal valid record with no GPA", () => {
    const result = EducationRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("accepts a full valid record including GPA + both grad dates + is_primary", () => {
    const result = EducationRequestSchema.safeParse({
      ...validBase,
      minor: "Mathematics",
      gpa_value: 3.7,
      gpa_scale: 4.0,
      expected_graduation_date: "2027-05-15",
      actual_graduation_date: "2027-05-15",
      is_primary: true,
    });
    expect(result.success).toBe(true);
  });

  it("defaults is_primary to false when omitted", () => {
    const result = EducationRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.is_primary).toBe(false);
  });

  it("accepts a non-4.0 GPA scale (international institutions)", () => {
    const result = EducationRequestSchema.safeParse({
      ...validBase,
      gpa_value: 8.5,
      gpa_scale: 10.0,
    });
    expect(result.success).toBe(true);
  });
});

describe("EducationRequestSchema — invalid dates (temporal rules)", () => {
  it("rejects expected_graduation_date before start_date", () => {
    const result = EducationRequestSchema.safeParse({
      ...validBase,
      start_date: "2023-08-15",
      expected_graduation_date: "2022-05-15",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.expected_graduation_date).toBeTruthy();
    }
  });

  it("rejects actual_graduation_date before start_date", () => {
    const result = EducationRequestSchema.safeParse({
      ...validBase,
      start_date: "2023-08-15",
      actual_graduation_date: "2020-01-01",
    });
    expect(result.success).toBe(false);
  });

  it("accepts expected_graduation_date exactly equal to start_date (boundary)", () => {
    const result = EducationRequestSchema.safeParse({
      ...validBase,
      start_date: "2023-08-15",
      expected_graduation_date: "2023-08-15",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed date string", () => {
    const result = EducationRequestSchema.safeParse({
      ...validBase,
      start_date: "08/15/2023",
    });
    expect(result.success).toBe(false);
  });
});

describe("EducationRequestSchema — GPA without scale", () => {
  it("rejects gpa_value provided without gpa_scale", () => {
    const result = EducationRequestSchema.safeParse({
      ...validBase,
      gpa_value: 3.8,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.gpa_scale).toBeTruthy();
    }
  });

  it("accepts gpa_scale provided without gpa_value (scale alone is harmless)", () => {
    const result = EducationRequestSchema.safeParse({
      ...validBase,
      gpa_scale: 4.0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects gpa_value greater than gpa_scale", () => {
    const result = EducationRequestSchema.safeParse({
      ...validBase,
      gpa_value: 4.5,
      gpa_scale: 4.0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative gpa_value", () => {
    const result = EducationRequestSchema.safeParse({
      ...validBase,
      gpa_value: -1,
      gpa_scale: 4.0,
    });
    expect(result.success).toBe(false);
  });
});

describe("EducationRequestSchema — other constraints", () => {
  it("rejects an unrecognized degree_type", () => {
    const result = EducationRequestSchema.safeParse({ ...validBase, degree_type: "doctorate" });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized enrollment_status", () => {
    const result = EducationRequestSchema.safeParse({ ...validBase, enrollment_status: "expelled" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing required field (major)", () => {
    const { major, ...rest } = validBase;
    const result = EducationRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe("UuidParamSchema", () => {
  it("accepts a well-formed uuid", () => {
    expect(UuidParamSchema.safeParse("3fa85f64-5717-4562-b3fc-2c963f66afa6").success).toBe(true);
  });

  it("rejects a non-uuid string", () => {
    expect(UuidParamSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});
