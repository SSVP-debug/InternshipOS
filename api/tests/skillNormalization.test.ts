import { describe, it, expect } from "vitest";
import { normalizeSkillName, normalizeSkillList } from "../src/lib/skillNormalization.js";

describe("normalizeSkillName — aliasing", () => {
  it("collapses React.js / ReactJS / React to the same normalized value", () => {
    expect(normalizeSkillName("React.js")).toBe("react");
    expect(normalizeSkillName("ReactJS")).toBe("react");
    expect(normalizeSkillName("React")).toBe("react");
    expect(normalizeSkillName("  react  ")).toBe("react");
  });

  it("collapses Node.js / NodeJS / Node to the same normalized value", () => {
    expect(normalizeSkillName("Node.js")).toBe("node");
    expect(normalizeSkillName("NodeJS")).toBe("node");
    expect(normalizeSkillName("Node")).toBe("node");
  });

  it("collapses Express.js / ExpressJS / Express to the same normalized value", () => {
    expect(normalizeSkillName("Express.js")).toBe("express");
    expect(normalizeSkillName("ExpressJS")).toBe("express");
    expect(normalizeSkillName("Express")).toBe("express");
  });

  it("collapses PostgreSQL / Postgres to the same normalized value", () => {
    expect(normalizeSkillName("PostgreSQL")).toBe("postgresql");
    expect(normalizeSkillName("Postgres")).toBe("postgresql");
  });

  it("collapses MongoDB / Mongo to the same normalized value", () => {
    expect(normalizeSkillName("MongoDB")).toBe("mongodb");
    expect(normalizeSkillName("Mongo")).toBe("mongodb");
  });
});

describe("normalizeSkillName — punctuation and whitespace", () => {
  it("treats '.', '-', '_' as equivalent separators", () => {
    expect(normalizeSkillName("Node-js")).toBe("node");
    expect(normalizeSkillName("Node_js")).toBe("node");
  });

  it("collapses internal whitespace runs", () => {
    expect(normalizeSkillName("Node   js")).toBe("node");
  });

  it("is case-insensitive", () => {
    expect(normalizeSkillName("REACT")).toBe("react");
  });

  it("passes through an unrecognized skill unchanged apart from normalization", () => {
    expect(normalizeSkillName("TypeScript")).toBe("typescript");
    expect(normalizeSkillName("Figma")).toBe("figma");
  });
});

describe("normalizeSkillName — empty/edge input", () => {
  it("returns an empty string for empty or whitespace-only input", () => {
    expect(normalizeSkillName("")).toBe("");
    expect(normalizeSkillName("   ")).toBe("");
  });
});

describe("normalizeSkillList", () => {
  it("de-duplicates aliases that normalize to the same value", () => {
    const result = normalizeSkillList(["React", "react", "ReactJS", "React.js"]);
    expect(result).toEqual(["react"]);
  });

  it("preserves order of first occurrence", () => {
    const result = normalizeSkillList(["Node", "React", "node"]);
    expect(result).toEqual(["node", "react"]);
  });

  it("drops empty/whitespace-only entries", () => {
    const result = normalizeSkillList(["React", "", "   ", "Node"]);
    expect(result).toEqual(["react", "node"]);
  });

  it("handles an empty list without crashing", () => {
    expect(normalizeSkillList([])).toEqual([]);
  });
});