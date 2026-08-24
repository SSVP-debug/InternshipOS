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
      // Malformed entry missing company.display_name — must be dropped, not crash the parser.
      id: "4455667792",
      title: "Design Intern",
      description: "Design internship, malformed fixture case.",
      created: "2026-08-11T06:12:00Z",
    },
  ],
};
