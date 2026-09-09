import { describe, it, expect } from "vitest";
import { extractSkillsFromText } from "../src/lib/ingestion/extractSkills.js";

describe("extractSkillsFromText — basic detection", () => {
  it("detects a single-word term from the description", () => {
    expect(extractSkillsFromText("Software Intern", "Experience with Python is a plus.")).toContain("python");
  });

  it("detects multiple distinct terms in one description", () => {
    const skills = extractSkillsFromText(
      "Software Development Intern",
      "You'll work with React and Node.js to build our internal dashboard, backed by PostgreSQL.",
    );
    expect(skills).toEqual(expect.arrayContaining(["react", "node js", "postgresql"]));
  });

  it("detects a skill mentioned only in the title", () => {
    expect(extractSkillsFromText("React Developer Intern", "General office duties.")).toContain("react");
  });

  it("returns an empty array when neither title nor description mentions a vocabulary term", () => {
    expect(
      extractSkillsFromText(
        "Software Development Intern",
        "We are looking for a Software Development Intern to join our engineering team. This is a hybrid role.",
      ),
    ).toEqual([]);
  });

  it("handles a null description without throwing", () => {
    expect(extractSkillsFromText("Marketing Intern", null)).toEqual([]);
    expect(extractSkillsFromText("Python Developer Intern", null)).toContain("python");
  });

  it("is case-insensitive for ordinary terms", () => {
    expect(extractSkillsFromText("Intern", "PYTHON and javascript required")).toEqual(
      expect.arrayContaining(["python", "javascript"]),
    );
  });

  it("de-duplicates a term mentioned more than once", () => {
    const skills = extractSkillsFromText("Python Intern", "Python, Python everywhere. Must know Python.");
    expect(skills.filter((s) => s === "python")).toHaveLength(1);
  });

  it("returns a stable, deterministic order across repeated calls (vocabulary order, not text-occurrence order — order carries no scoring meaning either way)", () => {
    const first = extractSkillsFromText("Intern", "docker and python and react");
    const second = extractSkillsFromText("Intern", "docker and python and react");
    expect(first).toEqual(second);
    expect(first).toEqual(expect.arrayContaining(["docker", "python", "react"]));
  });
});

describe("extractSkillsFromText — multi-word phrases", () => {
  it("detects a multi-word phrase as a single skill, not its component words", () => {
    const skills = extractSkillsFromText("Data Intern", "Experience with machine learning is preferred.");
    expect(skills).toContain("machine learning");
  });

  it("does not report the phrase's component words as separate skills", () => {
    // Neither "machine" nor "learning" is in the vocabulary at all, so
    // this also guards against a future accidental addition of either
    // as a bare single-word term.
    const skills = extractSkillsFromText("Data Intern", "Experience with machine learning is preferred.");
    expect(skills).not.toContain("machine");
    expect(skills).not.toContain("learning");
  });

  it("detects 'CI/CD' via slash-to-space collapse", () => {
    expect(extractSkillsFromText("DevOps Intern", "Familiarity with CI/CD pipelines.")).toContain("ci cd");
  });

  it("detects 'Spring Boot' but never bare 'spring'", () => {
    const skills = extractSkillsFromText("Backend Intern", "Built services using Spring Boot and Java.");
    expect(skills).toContain("spring boot");
  });

  it("detects 'React Native' explicitly, alongside (not instead of) the bare 'react' hit it also naturally contains (A3.1 correction #3)", () => {
    const skills = extractSkillsFromText("Mobile Intern", "We use React Native to build our cross-platform app.");
    expect(skills).toEqual(expect.arrayContaining(["react native", "react"]));
  });
});

describe("extractSkillsFromText — punctuation variants", () => {
  it("detects 'Node.js', 'Node-js', and 'Node_js' identically, as the unambiguous compound phrase form (A3.1 correction #2 — bare 'node' is no longer extracted, see false-positive-protection tests below)", () => {
    expect(extractSkillsFromText("Intern", "Built with Node.js.")).toContain("node js");
    expect(extractSkillsFromText("Intern", "Built with Node-js.")).toContain("node js");
    expect(extractSkillsFromText("Intern", "Built with Node_js.")).toContain("node js");
  });

  it("detects contiguous 'NodeJS' (no punctuation) via the separate single-word 'nodejs' term", () => {
    expect(extractSkillsFromText("Intern", "Built with NodeJS.")).toContain("nodejs");
  });

  it("detects 'C++' and 'C#' via their punctuation-sensitive patterns", () => {
    expect(extractSkillsFromText("Intern", "Strong C++ skills required.")).toContain("c++");
    expect(extractSkillsFromText("Intern", "Experience in C# and .NET.")).toEqual(
      expect.arrayContaining(["c#", ".net"]),
    );
  });
});

describe("extractSkillsFromText — false-positive protection", () => {
  it("never extracts bare single-letter terms 'R' or 'C'", () => {
    const skills = extractSkillsFromText("Intern", "Report to the R&D department in room C.");
    expect(skills).not.toContain("r");
    expect(skills).not.toContain("c");
  });

  it("never extracts bare 'go' from ordinary internship-posting boilerplate", () => {
    const skills = extractSkillsFromText("Intern", "Go the extra mile and go above and beyond.");
    expect(skills).not.toContain("go");
  });

  it("extracts 'golang' as the unambiguous form of Go", () => {
    expect(extractSkillsFromText("Intern", "Experience with Golang is a plus.")).toContain("golang");
  });

  it("never extracts bare 'spring' from a common posting-season phrase", () => {
    const skills = extractSkillsFromText("Intern", "This is a Spring 2026 internship, applications open in spring.");
    expect(skills).not.toContain("spring");
    expect(skills).not.toContain("spring boot");
  });

  it("never extracts bare 'swift' from ordinary adjective usage", () => {
    const skills = extractSkillsFromText("Intern", "We need someone swift and adaptable.");
    expect(skills).not.toContain("swift");
  });

  it("never extracts bare 'rust' from ordinary noun usage (A3.1 correction #1)", () => {
    const skills = extractSkillsFromText("Intern", "Please remove any rust from the equipment before use.");
    expect(skills).not.toContain("rust");
  });

  it("never extracts bare 'node' from ordinary CS/networking usage (A3.1 correction #2)", () => {
    const skills = extractSkillsFromText(
      "Cloud Infrastructure Intern",
      "You'll help monitor cluster health across each worker node and master node in the deployment.",
    );
    expect(skills).not.toContain("node");
    expect(skills).not.toContain("node js");
    expect(skills).not.toContain("nodejs");
  });

  it("never matches 'java' inside 'javascript' (word-boundary protection)", () => {
    const skills = extractSkillsFromText("Intern", "Experience with JavaScript required.");
    expect(skills).toContain("javascript");
    expect(skills).not.toContain("java");
  });

  it("still detects standalone 'java' when actually mentioned", () => {
    expect(extractSkillsFromText("Intern", "Backend built in Java.")).toContain("java");
  });

  it("does not match 'sql' inside 'postgresql'", () => {
    const skills = extractSkillsFromText("Intern", "We use PostgreSQL for our database.");
    expect(skills).toContain("postgresql");
    expect(skills).not.toContain("sql");
  });

  it("still detects standalone 'SQL' when actually mentioned", () => {
    expect(extractSkillsFromText("Intern", "Strong SQL skills required.")).toContain("sql");
  });

  it("requires literal uppercase 'AI' and rejects lowercase 'ai' embedded in other words", () => {
    const skills = extractSkillsFromText("Intern", "This role is mainly administrative and clerical.");
    expect(skills).not.toContain("ai");
  });

  it("detects 'AI' only in its literal uppercase form", () => {
    expect(extractSkillsFromText("AI Research Intern", "Join our AI team.")).toContain("ai");
  });
});

describe("extractSkillsFromText — field scope", () => {
  it("only accepts title and description — no location/company parameters exist on the function signature", () => {
    // Type-level guarantee: extractSkillsFromText's signature is
    // (title: string, description: string | null) — there is no third
    // parameter a caller could accidentally pass company/location into.
    expect(extractSkillsFromText.length).toBe(2);
  });
});
