import crypto from "node:crypto";
import ExcelJS from "exceljs";
import type { IncomingMessage, ServerResponse } from "node:http";

type Request = IncomingMessage & { body?: unknown; url?: string };
type Response = ServerResponse & { status: (code: number) => Response; json: (value: unknown) => void };
type ReportType = "detailed-xlsx" | "detailed-pdf" | "period-xlsx" | "statement-pdf" | "monthly-xlsx" | "cover-pdf";
const unavailable = "Not Available in System";

function body(req: Request) {
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return (req.body ?? {}) as Record<string, string>;
}
function safeName(value: string) { return value.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "Employee"; }
function hash(buffer: Buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function pdfEscape(value: unknown) { return String(value ?? "").replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7e]/g, "?"); }
/** Small dependency-free, immutable-at-issue PDF. Registry hash detects changes. */
function textPdf(lines: string[]) {
  const pages: string[][] = [];
  for (let i = 0; i < lines.length || !pages.length; i += 46) pages.push(lines.slice(i, i + 46));
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  pages.forEach((page, index) => {
    const pageObject = 3 + index * 2, contentObject = pageObject + 1;
    const content = ["BT", "/F1 9 Tf", "42 800 Td", ...page.map((line, i) => `${i ? "0 -16 Td" : ""} (${pdfEscape(line)}) Tj`), "ET"].join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(x => `${String(x).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
function tabularRows(snapshot: any, type: ReportType) {
  if (type.startsWith("detailed")) return snapshot.attendance.map((a: any) => ({
    employeeName: snapshot.employee.fullName, employeeId: snapshot.employee.personnelCode, date: a.workDate, status: a.recordStatus ?? a.computedStatus,
    scheduledHours: Number(a.requiredMinutes ?? 0) / 60, checkIn: a.checkInMinute ?? unavailable, checkOut: a.checkOutMinute ?? unavailable,
    regularHours: Math.min(Number(a.actualMinutes ?? 0), Number(a.requiredMinutes ?? 0)) / 60, overtimeHours: Number(a.overtimeMinutes ?? 0) / 60,
    paidLeaveHours: Number(a.paidLeaveMinutes ?? 0) / 60, unpaidAbsenceHours: Number(a.unpaidLeaveMinutes ?? 0) / 60,
    source: a.recordSource ?? unavailable, approver: a.approvedBy ?? unavailable, approvedAt: a.approvedAt ?? unavailable,
    department: a.department ?? unavailable, jobCode: a.jobCode ?? unavailable, costCentre: a.costCentre ?? unavailable,
  }));
  if (type.startsWith("period")) return snapshot.results.map((r: any) => { const p = snapshot.payPeriods.find((x: any) => x.id === r.periodId) ?? {}; return {
    employeeName: snapshot.employee.fullName, employeeId: snapshot.employee.personnelCode, payPeriodId: p.payPeriodId ?? unavailable,
    start: p.periodStart ?? unavailable, end: p.periodEnd ?? unavailable, regularHours: r.regularHours, overtimeHours: r.overtimeHours,
    paidLeaveHours: r.paidLeaveHours, unpaidAbsenceHours: r.unpaidAbsenceHours, status: p.payrollStatus ?? unavailable, paymentDate: p.paymentDate ?? unavailable,
  }; });
  return snapshot.monthly;
}
async function workbook(snapshot: any, type: ReportType) {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("DASTRANJ export");
  sheet.addRow([snapshot.classification]); sheet.addRow([`Timezone: ${snapshot.range.timezone}`]); sheet.addRow([`Employee: ${snapshot.employee.fullName} (${snapshot.employee.personnelCode})`]); sheet.addRow([]);
  const rows = tabularRows(snapshot, type); const keys = Object.keys(rows[0] ?? { status: unavailable }); sheet.addRow(keys);
  rows.forEach((row: any) => sheet.addRow(keys.map(key => row[key] ?? unavailable)));
  sheet.getRow(5).font = { bold: true }; sheet.columns.forEach(col => col.width = 20);
  return Buffer.from(await book.xlsx.writeBuffer());
}
function pdfLines(snapshot: any, type: ReportType, reportId: string) {
  const title = type === "cover-pdf" ? "HR / Payroll Data Source Certification" : type === "statement-pdf" ? "Payroll Statement of Earnings" : "DASTRANJ Detailed Time Export";
  const seed = Boolean(snapshot.employee.isDemo);
  const lines = [title, snapshot.classification, `Report ID: ${reportId}`, `Timezone: ${snapshot.range.timezone}`, `Employee: ${snapshot.employee.fullName} (${snapshot.employee.personnelCode})`, `Range: ${snapshot.range.start} to ${snapshot.range.end}`, `Issuer: Hamideh Zeinali — Business owner / employer`, ""];
  if (type === "cover-pdf") {
    lines.push(seed ? "This package contains fictional seeded test data. It must not be used for IRCC or employment proof." : "This job exported only existing system records. It did not create, change, estimate, backdate, or approve any time, leave, or payroll data.");
    lines.push("Missing fields are represented as: Not Available in System.");
  } else if (type === "statement-pdf") {
    snapshot.results.forEach((r: any) => lines.push(`Period ${r.year}-${String(r.month).padStart(2, "0")}: Gross $${r.gross}; CPP $${r.cpp}; CPP2 $${r.cpp2}; EI $${r.ei}; Federal $${r.federalTax}; Ontario $${r.ontarioTax}; Net $${r.net}`));
  } else {
    tabularRows(snapshot, "detailed-pdf").forEach((r: any) => lines.push(`${r.date} | regular ${r.regularHours} | OT ${r.overtimeHours} | paid leave ${r.paidLeaveHours} | status ${r.status} | ${r.source}`));
  }
  lines.push("", `Verify this file: /verify/${reportId}`);
  return lines;
}
async function scriptFetch(path: string, init?: RequestInit) {
  const url = process.env.GOOGLE_SCRIPT_URL; if (!url) throw new Error("GOOGLE_SCRIPT_URL is not configured");
  const target = new URL(url); const [route, query] = path.split("?", 2); target.searchParams.set("path", route);
  if (query) new URLSearchParams(query).forEach((value, key) => target.searchParams.set(key, value));
  const response = await fetch(target, init); const data = await response.json(); if (data?.error) throw new Error(data.error); return data;
}
export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
  try {
    const input = body(req), type = input.type as ReportType, employeeId = input.employeeId, start = input.start, end = input.end;
    if (!employeeId || !start || !end || !["detailed-xlsx","detailed-pdf","period-xlsx","statement-pdf","monthly-xlsx","cover-pdf"].includes(type)) return res.status(400).json({ error: "employeeId, start, end and a valid report type are required" });
    const snapshot = await scriptFetch(`reports/snapshot?employeeId=${encodeURIComponent(employeeId)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    const reportId = crypto.randomUUID(), person = safeName(snapshot.employee.fullName), range = `${start}_to_${end}`;
    const base = type === "detailed-xlsx" || type === "detailed-pdf" ? `01_DASTRANJ_Detailed_Time_Export_${person}_${range}` : type === "period-xlsx" ? `02_DASTRANJ_Pay_Period_Hours_Summary_${person}_${range}` : type === "statement-pdf" ? `03_Payroll_Statement_of_Earnings_${person}_${range}` : type === "monthly-xlsx" ? `04_Monthly_Hours_and_Payroll_Summary_${person}_${range}` : `05_HR_Payroll_Data_Source_Certification_${person}`;
    const isXlsx = type.endsWith("xlsx"), file = isXlsx ? await workbook(snapshot, type) : textPdf(pdfLines(snapshot, type, reportId));
    const digest = hash(file), fileName = `${base}.${isXlsx ? "xlsx" : "pdf"}`;
    await scriptFetch("reports/register", { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ id: reportId, reportNumber: `RPT-${Date.now()}`, employeeId, employeeName: snapshot.employee.fullName, rangeStart: start, rangeEnd: end, reportType: type, fileName, pdfHash: digest, payloadHash: hash(Buffer.from(JSON.stringify(snapshot))), issuedAt: new Date().toISOString(), isDemo: Boolean(snapshot.employee.isDemo), snapshot }) });
    res.status(200); res.setHeader("Content-Type", isXlsx ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf"); res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`); res.setHeader("X-Report-Id", reportId); res.setHeader("X-Report-SHA256", digest); res.end(file);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
}
