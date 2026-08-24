// remoteokSample.ts
// Representative RemoteOK /api response shape, hand-built from the
// documented field names (position, company, tags, description, url,
// date/epoch, location) used across every third-party client of this
// API. Deliberately includes the real quirk this feed is known for: the
// first array element is a legal/notice object with no id/position/
// company — parseRemoteOkListings must filter it out, not just happen
// to skip index 0.

export const remoteOkSampleResponse: unknown[] = [
  {
    legal: "This is not a job, it's a legal notice about API use.",
    // No id/position/company on purpose.
  },
  {
    id: "1010101",
    position: "Frontend Engineering Intern",
    company: "Nimbus Labs",
    tags: ["react", "javascript", "intern"],
    description: "<p>Join our team as a <b>Frontend Engineering Intern</b> working on our React.js dashboard.</p>",
    location: "Worldwide",
    url: "https://remoteok.com/remote-jobs/1010101-frontend-engineering-intern-nimbus-labs",
    date: "2026-08-10T09:00:00+00:00",
  },
  {
    id: "1010102",
    position: "Senior Backend Engineer", // not an internship — should be filtered out
    company: "Nimbus Labs",
    tags: ["node", "postgresql"],
    description: "<p>We are hiring a Senior Backend Engineer with 5+ years experience.</p>",
    location: "Worldwide",
    url: "https://remoteok.com/remote-jobs/1010102-senior-backend-engineer-nimbus-labs",
    date: "2026-08-11T09:00:00+00:00",
  },
  {
    id: "1010103",
    position: "Data Science Internship",
    company: "Vellum Analytics",
    tags: ["python", "internship"],
    description: "<p>Summer internship program for Data Science students.</p>",
    location: "",
    url: "https://remoteok.com/remote-jobs/1010103-data-science-internship-vellum-analytics",
    epoch: 1786000000,
  },
  {
    // Malformed entry missing company — must be dropped, not crash the parser.
    id: "1010104",
    position: "Marketing Intern",
    tags: ["marketing"],
    description: "<p>Marketing internship, no company listed (malformed fixture case).</p>",
  },
];
