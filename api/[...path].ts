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

/** Same-origin Vercel proxy for the Google Apps Script Web App. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
  if (!scriptUrl) return res.status(500).json({ error: "GOOGLE_SCRIPT_URL is not configured" });
  const incoming = new URL(req.url ?? "/api", "http://vercel.internal");
  const path = incoming.searchParams.get("path") || incoming.pathname.replace(/^\/api\/?/, "");

  // Keep custom binary/report endpoints within this one deployed Function.
  // Every other endpoint is a transparent proxy to Apps Script.
  if (path === "export" || path === "export.xlsx") {
    const { default: exportWorkbook } = await import("../server/vercel-export-workbook");
    return exportWorkbook(req, res);
  }
  if (path === "reports/generate") {
    const { default: generateReport } = await import("../server/vercel-report-generator");
    return generateReport(req, res);
  }
  if (path === "reports/verify") {
    const { default: verifyReport } = await import("../server/vercel-report-verifier");
    return verifyReport(req, res);
  }
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
