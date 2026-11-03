// Saved-shape fixtures for the Greenhouse / Lever / Ashby / Remotive adapters.
// Shapes mirror each vendor's documented public response (see each adapter's
// header); values are invented. Each fixture deliberately mixes real
// internships with non-internships, "internal"/"international" false
// friends, and malformed entries, so the filters are exercised for real.

export const greenhouseSampleResponse = {
  jobs: [
    {
      id: 4001,
      title: "Software Engineering Intern",
      location: { name: "Remote - India" },
      absolute_url: "https://boards.greenhouse.io/acme/jobs/4001",
      first_published: "2026-10-01T09:30:00-04:00",
      updated_at: "2026-10-05T12:00:00-04:00",
      // Greenhouse HTML is entity-escaped.
      content:
        "&lt;p&gt;Build APIs with Python &amp;amp; Django. Experience with React is a plus.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Visa sponsorship available&lt;/li&gt;&lt;/ul&gt;",
    },
    {
      id: 4002,
      title: "Senior Backend Engineer",
      location: { name: "Bengaluru" },
      absolute_url: "https://boards.greenhouse.io/acme/jobs/4002",
      updated_at: "2026-10-02T10:00:00Z",
      content: "&lt;p&gt;We love our internship program!&lt;/p&gt;",
    },
    {
      id: 4003,
      title: "Internal Tools Engineer",
      location: { name: "Hybrid (Bengaluru)" },
      absolute_url: "https://boards.greenhouse.io/acme/jobs/4003",
    },
    {
      id: 4004,
      title: "Data Science Internship",
      location: { name: "Bengaluru, India" },
      absolute_url: "https://boards.greenhouse.io/acme/jobs/4004",
      updated_at: "2026-10-03T00:00:00Z",
      content: "",
    },
    { id: 4005, title: "   ", location: null, absolute_url: "https://boards.greenhouse.io/acme/jobs/4005" },
    { title: "Intern without an id" },
    null,
  ],
  meta: { total: 7 },
};

export const leverSampleResponse = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    text: "Backend Engineer Intern",
    hostedUrl: "https://jobs.lever.co/acme/11111111-1111-4111-8111-111111111111",
    applyUrl: "https://jobs.lever.co/acme/11111111-1111-4111-8111-111111111111/apply",
    createdAt: 1760000000000, // epoch MILLISECONDS → 2025-10-09
    categories: { location: "Remote", commitment: "Intern", team: "Platform" },
    workplaceType: "remote",
    descriptionPlain: "Work on Node.js services. We will not offer visa sponsorship.",
  },
  {
    // Not "intern" in the title, but structured commitment says Internship.
    id: "22222222-2222-4222-8222-222222222222",
    text: "Machine Learning Engineer (Summer)",
    hostedUrl: "https://jobs.lever.co/acme/22222222-2222-4222-8222-222222222222",
    createdAt: 1760086400000,
    categories: { location: "Hyderabad, India", commitment: "Internship" },
    workplaceType: "unspecified",
    descriptionPlain: "PyTorch and Python.",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    text: "Staff Engineer",
    hostedUrl: "https://jobs.lever.co/acme/33333333-3333-4333-8333-333333333333",
    createdAt: 1760086400000,
    categories: { location: "Remote", commitment: "Full-time" },
    workplaceType: "remote",
    descriptionPlain: "Our interns love it here.",
  },
  { text: "Intern with no id", categories: {} },
  "not-an-object",
];

export const ashbySampleResponse = {
  jobs: [
    {
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      title: "Product Engineer",
      location: "Bengaluru",
      employmentType: "Intern",
      workplaceType: "Hybrid",
      isRemote: false,
      isListed: true,
      jobUrl: "https://jobs.ashbyhq.com/acme/aaaaaaaa-0000-4000-8000-000000000001",
      applyUrl: "https://jobs.ashbyhq.com/acme/aaaaaaaa-0000-4000-8000-000000000001/application",
      publishedAt: "2026-09-20T08:00:00.000+00:00",
      descriptionPlain: "TypeScript and PostgreSQL.",
    },
    {
      id: "aaaaaaaa-0000-4000-8000-000000000002",
      title: "Frontend Engineering Intern",
      location: "Remote (Global)",
      employmentType: "FullTime",
      isRemote: true,
      jobUrl: "https://jobs.ashbyhq.com/acme/aaaaaaaa-0000-4000-8000-000000000002",
      publishedAt: "2026-09-21T08:00:00.000+00:00",
    },
    {
      id: "aaaaaaaa-0000-4000-8000-000000000003",
      title: "Software Engineer",
      location: "Remote",
      employmentType: "FullTime",
      isListed: true,
      jobUrl: "https://jobs.ashbyhq.com/acme/aaaaaaaa-0000-4000-8000-000000000003",
    },
    {
      id: "aaaaaaaa-0000-4000-8000-000000000004",
      title: "Hidden Intern Role",
      employmentType: "Intern",
      isListed: false,
      jobUrl: "https://jobs.ashbyhq.com/acme/aaaaaaaa-0000-4000-8000-000000000004",
    },
    { title: "Intern with no id" },
  ],
};

export const remotiveSampleResponse = {
  "0-legal-notice": "Remotive API Legal Notice",
  "job-count": 5,
  jobs: [
    {
      id: 2001,
      url: "https://remotive.com/remote-jobs/software-dev/python-intern-2001",
      title: "Python Developer Intern",
      company_name: "Orbit Labs",
      category: "Software Development",
      tags: ["python", "django", "startup"],
      job_type: "internship",
      publication_date: "2026-10-10T10:23:26",
      candidate_required_location: "Worldwide",
      salary: "",
      description: "<p>Join us as an intern. Visa sponsorship is not available.</p>",
    },
    {
      id: 2002,
      url: "https://remotive.com/remote-jobs/software-dev/data-2002",
      title: "Junior Data Analyst",
      company_name: "Quill",
      tags: ["sql"],
      job_type: "full_time",
      publication_date: "2026-10-11T10:23:26",
      candidate_required_location: "USA Only",
      description: "<p>Our summer internship program is separate.</p>",
    },
    {
      id: 2003,
      url: "https://remotive.com/remote-jobs/software-dev/qa-2003",
      title: "QA Trainee",
      company_name: "Kite",
      tags: [],
      job_type: "internship", // structured type alone is enough
      publication_date: "2026-10-12T10:23:26",
      candidate_required_location: "",
      description: "",
    },
    { id: 2004, title: "Intern with no company", url: "https://remotive.com/x" },
    { title: "Intern with no id", company_name: "Nobody" },
  ],
};
