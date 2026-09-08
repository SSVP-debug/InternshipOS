// pdfExport.ts
// Renders the same data account.ts's /export route always queried into a
// readable PDF instead of a raw JSON dump. This is a direct, deliberate
// departure from docs/candidate-truth-layer-phase0.md §6's original call
// for "a structured (JSON) dump" — that requirement was about data
// portability; here the candidate explicitly wants a document to read,
// not a machine-readable file. Nothing about the underlying query in
// account.ts changed — every table §6/§3 lists is still fetched and still
// appears here, just formatted as text instead of serialized as JSON.
//
// Deliberately generic (humanizeKey/formatValue/addSection) rather than a
// bespoke renderer per entity: every one of these tables is just "a list
// of flat label/value rows", and none of them (per the export route's own
// query list) currently carry nested JSON — see the same audit that
// picked this approach for the one exception (opportunity_match.
// match_breakdown), which isn't part of this export at all today. If a
// nested-JSON field ever is added to one of these tables, formatValue's
// JSON.stringify fallback degrades to something ugly-but-correct rather
// than crashing.

import PDFDocument from "pdfkit";

type Row = Record<string, unknown>;

const LABEL_OVERRIDES: Record<string, string> = {
  id: "ID",
  url: "URL",
  gpa: "GPA",
};

function humanizeKey(key: string): string {
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key];
  return key
    .split("_")
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function addHeading(doc: PDFKit.PDFDocument, text: string): void {
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(15).fillColor("#1a1a1a").text(text);
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor("#000000");
}

function addRecord(doc: PDFKit.PDFDocument, record: Row): void {
  for (const [key, value] of Object.entries(record)) {
    doc.font("Helvetica-Bold").fontSize(10).text(`${humanizeKey(key)}: `, { continued: true });
    doc.font("Helvetica").fontSize(10).text(formatValue(value));
  }
}

// rows may be a single record (personal_info, work_authorization — both
// maybeSingle() in account.ts), an array (everything else), or null/empty.
function addSection(doc: PDFKit.PDFDocument, title: string, rows: Row[] | Row | null): void {
  addHeading(doc, title);

  const list = rows === null ? [] : Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) {
    doc.font("Helvetica-Oblique").fillColor("#666666").text("None.");
    doc.fillColor("#000000");
    return;
  }

  list.forEach((row, i) => {
    addRecord(doc, row);
    if (i < list.length - 1) {
      doc.moveDown(0.3);
      const lineY = doc.y;
      doc
        .moveTo(doc.page.margins.left, lineY)
        .lineTo(doc.page.width - doc.page.margins.right, lineY)
        .strokeColor("#dddddd")
        .lineWidth(0.5)
        .stroke()
        .strokeColor("#000000");
      doc.moveDown(0.3);
    }
  });
}

export interface ExportData {
  exported_at: string;
  candidate: Row;
  personal_info: Row | null;
  consent_records: Row[];
  education: Row[];
  work_authorization: Row | null;
  skills: Row[];
  projects: Row[];
  experiences: Row[];
  achievements: Row[];
  certifications: Row[];
  evidence_sources: Row[];
  claims: Row[];
  opportunities: Row[];
  applications: Row[];
  application_status_events: Row[];
  application_notes: Row[];
}

// Returns the open, streaming PDFDocument — caller (account.ts) pipes it
// to the response and is responsible for setting headers before piping,
// same division of concerns as any other Node stream producer/consumer.
export function buildExportPdf(data: ExportData): PDFKit.PDFDocument {
  const doc = new PDFDocument({ margin: 50, bufferPages: true });

  doc.font("Helvetica-Bold").fontSize(22).fillColor("#1a1a1a").text("InternshipOS — Data Export");
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#555555")
    .text(`Exported ${new Date(data.exported_at).toLocaleString()}`);
  doc.fillColor("#000000");

  addSection(doc, "Account", data.candidate);
  addSection(doc, "Personal Information", data.personal_info);
  addSection(doc, "Consent Records", data.consent_records);
  addSection(doc, "Education", data.education);
  addSection(doc, "Work Authorization", data.work_authorization);
  addSection(doc, "Skills", data.skills);
  addSection(doc, "Projects", data.projects);
  addSection(doc, "Experience", data.experiences);
  addSection(doc, "Achievements", data.achievements);
  addSection(doc, "Certifications", data.certifications);
  addSection(doc, "Evidence Sources", data.evidence_sources);
  addSection(doc, "Claims", data.claims);
  addSection(doc, "Opportunities", data.opportunities);
  addSection(doc, "Applications", data.applications);
  addSection(doc, "Application Status Events", data.application_status_events);
  addSection(doc, "Application Notes", data.application_notes);

  doc.end();
  return doc;
}
