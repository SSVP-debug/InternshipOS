// adzunaSample.ts
// Representative Adzuna /v1/api/jobs/in/search response shape, hand-
// built from the documented field names (title, company.display_name,
// location.display_name, description, redirect_url, created) per
// https://developer.adzuna.com/.

export const adzunaSampleResponse: unknown = {
  count: 3,
  results: [
    {
      id: "4455667788",
      title: "Software Development Intern",
      company: { display_name: "Kavali Systems Pvt Ltd" },
      location: { display_name: "Bengaluru, Karnataka" },
      description:
        "We are looking for a Software Development Intern to join our engineering team. This is a hybrid role based in our Bengaluru office.",
      redirect_url: "https://www.adzuna.in/land/ad/4455667788",
      created: "2026-08-15T06:12:00Z",
    },
    {
      id: "4455667789",
      title: "Senior Software Engineer", // not an internship — should be filtered out
      company: { display_name: "Kavali Systems Pvt Ltd" },
      location: { display_name: "Bengaluru, Karnataka" },
      description: "5+ years of experience required, full-time role.",
      redirect_url: "https://www.adzuna.in/land/ad/4455667789",
      created: "2026-08-14T06:12:00Z",
    },
    {
      id: "4455667790",
      title: "International Business Development Executive", // contains "Internatio-" — must NOT match "intern" filter
      company: { display_name: "Global Traders" },
      location: { display_name: "Mumbai, Maharashtra" },
      description: "Manage international client relationships. Full-time.",
      redirect_url: "https://www.adzuna.in/land/ad/4455667790",
      created: "2026-08-13T06:12:00Z",
    },
    {
      id: "4455667791",
      title: "Marketing Internship (Remote)",
      company: { display_name: "Bloomreach Digital" },
      location: { display_name: "Delhi, India" },
      description: "Fully remote marketing internship for final-year students.",
      redirect_url: "https://www.adzuna.in/land/ad/4455667791",
      created: "2026-08-12T06:12:00Z",
    },
    {
      // A3.1: real-shaped listing with unambiguous, explicit skill
      // mentions — proves extraction actually populates `skills` end to
      // end through the adapter, not just at the extractSkills.ts unit
      // level.
      id: "4455667793",
      title: "Backend Development Intern",
      company: { display_name: "Kavali Systems Pvt Ltd" },
      location: { display_name: "Bengaluru, Karnataka" },
      description:
        "We're looking for an intern to help build a REST API in Node.js and Express, backed by PostgreSQL. Experience with Python and Git is a plus.",
      redirect_url: "https://www.adzuna.in/land/ad/4455667793",
      created: "2026-08-10T06:12:00Z",
    },
    {
      // A3.1: real-shaped listing whose description is ordinary
      // internship-posting boilerplate containing several of the
      // deliberately-excluded ambiguous terms (Spring as a season, Go as
      // a verb) — proves the false-positive guards hold through the
      // full adapter path, not just at the extractSkills.ts unit level.
      id: "4455667794",
      title: "Operations Internship — Spring 2026",
      company: { display_name: "Global Traders" },
      location: { display_name: "Mumbai, Maharashtra" },
      description: "This Spring 2026 internship is a great way to go the extra mile and grow your career.",
      redirect_url: "https://www.adzuna.in/land/ad/4455667794",
      created: "2026-08-09T06:12:00Z",
    },
    {
      // Malformed entry missing company.display_name — must be dropped, not crash the parser.
      id: "4455667792",
      title: "Design Intern",
      description: "Design internship, malformed fixture case.",
      created: "2026-08-11T06:12:00Z",
    },
  ],
};
