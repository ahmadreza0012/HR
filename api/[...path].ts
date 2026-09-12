import type { IncomingMessage, ServerResponse } from "node:http";

type VercelRequest = IncomingMessage & { url?: string; body?: unknown };
type VercelResponse = ServerResponse & {
  status: (code: number) => VercelResponse;
  json: (value: unknown) => void;
};
type RecordValue = Record<string, unknown>;

const number = (value: unknown) => Number(value ?? 0) || 0;
const text = (value: unknown) => String(value ?? "");

async function readSheetsResource(scriptUrl: string, path: string): Promise<RecordValue[]> {
  const target = new URL(scriptUrl);
  target.searchParams.set("path", path);
  const response = await fetch(target, { redirect: "follow" });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error(`${path}: invalid response`);
  return payload as RecordValue[];
}

const pdfText = (value: unknown) => String(value ?? "").replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7e]/g, "?");
function createPdf(lines: string[]) {
  const content = ["BT", "/F1 10 Tf", "42 800 Td", ...lines.slice(0, 46).map((line, index) => `${index ? "0 -16 Td" : ""} (${pdfText(line)}) Tj`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

async function generateReport(req: VercelRequest, res: VercelResponse, scriptUrl: string) {
  if (req.method !== "POST") return res.status(405).end("POST required");
  try {
    const input = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {}) as Record<string, string>;
    const employeeId = String(input.employeeId ?? ""), start = String(input.start ?? ""), end = String(input.end ?? ""), type = String(input.type ?? "");
    if (!employeeId || !start || !end || !["detailed-xlsx", "detailed-pdf", "period-xlsx", "statement-pdf", "monthly-xlsx", "cover-pdf"].includes(type)) {
      return res.status(400).json({ error: "employeeId, start, end and a valid report type are required" });
    }
    const target = new URL(scriptUrl);
    target.searchParams.set("path", "reports/snapshot");
    target.searchParams.set("employeeId", employeeId); target.searchParams.set("start", start); target.searchParams.set("end", end);
    const upstream = await fetch(target); const snapshot = await upstream.json() as RecordValue;
    if (!upstream.ok || snapshot.error) throw new Error(String(snapshot.error ?? `snapshot: ${upstream.status}`));
    const employee = (snapshot.employee ?? {}) as RecordValue;
    const rows = type.startsWith("period") ? (snapshot.results ?? []) : type.startsWith("monthly") ? (snapshot.monthly ?? []) : (snapshot.attendance ?? []);
    const reportId = `RPT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isExcel = type.endsWith("xlsx");
    const fileName = `${type}_${String(employee.personnelCode ?? employeeId).replace(/[^a-z0-9_-]/gi, "_")}_${start}_to_${end}.${isExcel ? "csv" : "pdf"}`;
    const file = isExcel
      ? Buffer.from(`\ufeff${Object.keys((rows as RecordValue[])[0] ?? {}).join(",")}\n${(rows as RecordValue[]).map((row) => Object.values(row).map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\n")}`, "utf8")
      : createPdf(["HR / Payroll report", `Report ID: ${reportId}`, `Employee: ${employee.fullName ?? employeeId}`, `Range: ${start} to ${end}`, "", ...(rows as RecordValue[]).map((row) => JSON.stringify(row))]);
    res.status(200);
    res.setHeader("Content-Type", isExcel ? "text/csv; charset=utf-8" : "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("X-Report-Id", reportId); res.end(file);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

/** Same-origin Vercel proxy for the Google Apps Script Web App. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
  if (!scriptUrl) return res.status(500).json({ error: "GOOGLE_SCRIPT_URL is not configured" });
  const incoming = new URL(req.url ?? "/api", "http://vercel.internal");
  const path = incoming.searchParams.get("path") || incoming.pathname.replace(/^\/api\/?/, "");

  // Keep custom binary/report endpoints within this one deployed Function.
  // Every other endpoint is a transparent proxy to Apps Script.
  if (path === "reports/generate") return generateReport(req, res, scriptUrl);
  if (path === "monthly") {
    try {
      const [employees, attendance] = await Promise.all([
        readSheetsResource(scriptUrl, "employees"),
        readSheetsResource(scriptUrl, "attendance"),
      ]);
      const year = Number(incoming.searchParams.get("year") ?? new Date().getFullYear());
      const month = Number(incoming.searchParams.get("month") ?? new Date().getMonth() + 1);
      const prefix = `${year}-${String(month).padStart(2, "0")}`;
      const rows = employees
        .filter((employee) => text(employee.employmentStatus) === "active")
        .map((employee) => {
          const entries = attendance.filter(
            (entry) => text(entry.employeeId) === text(employee.id) && text(entry.workDate).startsWith(prefix),
          );
          const status = (entry: RecordValue) => text(entry.overrideStatus || entry.computedStatus || entry.recordStatus);
          return {
            id: text(employee.id), fullName: text(employee.fullName), personnelCode: text(employee.personnelCode),
            requiredDays: new Set(entries.filter((entry) => number(entry.requiredMinutes) > 0).map((entry) => text(entry.workDate))).size,
            scheduledMinutes: entries.reduce((sum, entry) => sum + number(entry.requiredMinutes), 0),
            recordedDays: entries.length,
            presentDays: entries.filter((entry) => ["present", "approved"].includes(status(entry))).length,
            absentDays: entries.filter((entry) => status(entry) === "absent").length,
            leaveDays: entries.filter((entry) => status(entry) === "leave").length,
            actualMinutes: entries.reduce((sum, entry) => sum + number(entry.actualMinutes), 0),
            requiredMinutes: entries.reduce((sum, entry) => sum + number(entry.requiredMinutes), 0),
            leaveMinutes: entries.reduce((sum, entry) => sum + number(entry.leaveMinutes), 0),
            paidLeaveMinutes: entries.reduce((sum, entry) => sum + number(entry.paidLeaveMinutes), 0),
            unpaidLeaveMinutes: entries.reduce((sum, entry) => sum + number(entry.unpaidLeaveMinutes), 0),
            deficitMinutes: entries.reduce((sum, entry) => sum + number(entry.deficitMinutes), 0),
            overtimeMinutes: entries.reduce((sum, entry) => sum + number(entry.overtimeMinutes), 0),
          };
        });
      res.status(200);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
      return res.end(JSON.stringify(rows));
    } catch (error) {
      res.status(502);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }

  const target = new URL(scriptUrl);
  target.searchParams.set("path", path);
  for (const [key, value] of incoming.searchParams) {
    if (key !== "path") target.searchParams.append(key, value);
  }
  if (req.method && req.method !== "GET" && req.method !== "POST")
    target.searchParams.set("method", req.method);
  const body = req.method === "GET" || req.method === "HEAD"
    ? undefined
    : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  try {
    const upstream = await fetch(target, {
      method: req.method === "GET" || req.method === "HEAD" ? req.method : "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      redirect: "follow",
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
    if (req.method === "GET" && upstream.ok) {
      // Serve repeated Sheet reads from Vercel's edge cache; the browser gets
      // stale data immediately while the CDN refreshes in the background.
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    }
    res.end(text);
  } catch (error) {
    res.status(502).json({ error: String(error) });
  }
}
