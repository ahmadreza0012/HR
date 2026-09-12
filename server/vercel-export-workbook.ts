// Invoked by the consolidated Vercel API handler.
import ExcelJS from "exceljs";
import type { IncomingMessage, ServerResponse } from "node:http";

type Response = ServerResponse & { status: (code: number) => Response; json: (value: unknown) => void };
type Row = Record<string, unknown>;

const resources = [
  ["Employees", "employees"], ["Attendance", "attendance"], ["Holidays", "holidays"],
  ["Leave types", "leave-types"], ["Schedule overrides", "schedule-overrides"],
  ["Formula components", "formulas"], ["Formula versions", "formula_versions"], ["Payroll periods", "payroll/periods"],
  ["Payroll results", "payroll/results"], ["Audit log", "audit"], ["Settings", "settings"], ["Report registry", "report-registry"],
] as const;

function display(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return value as string | number | boolean;
}
function normalizeRows(payload: unknown): Row[] {
  if (Array.isArray(payload)) return payload as Row[];
  return payload && typeof payload === "object" ? [payload as Row] : [];
}
async function source(resource: string) {
  const base = process.env.GOOGLE_SCRIPT_URL; if (!base) throw new Error("GOOGLE_SCRIPT_URL is not configured");
  const target = new URL(base); target.searchParams.set("path", resource);
  const response = await fetch(target, { redirect: "follow" });
  if (!response.ok) throw new Error(`${resource}: ${response.status}`);
  const payload = await response.json(); if (payload?.error) throw new Error(`${resource}: ${payload.error}`);
  return payload;
}
function columnName(index: number) {
  let name = "", value = index;
  while (value > 0) { const remainder = (value - 1) % 26; name = String.fromCharCode(65 + remainder) + name; value = Math.floor((value - 1) / 26); }
  return name;
}
function addDataSheet(book: ExcelJS.Workbook, title: string, rows: Row[]) {
  const sheet = book.addWorksheet(title);
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  sheet.addRow(keys.length ? keys : ["Not Available in System"]);
  rows.forEach(row => sheet.addRow(keys.map(key => display(row[key]))));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: `${columnName(Math.max(keys.length, 1))}1` };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17324D" } };
  keys.forEach((key, index) => { sheet.getColumn(index + 1).width = Math.min(42, Math.max(14, key.length + 3)); });
  for (let row = 2; row <= sheet.rowCount; row += 1) sheet.getRow(row).alignment = { vertical: "top", wrapText: true };
  return sheet;
}

export default async function handler(_req: IncomingMessage, res: Response) {
  try {
    const [payloads, scheduleBundle] = await Promise.all([
      Promise.all(resources.map(([, resource]) => source(resource))),
      source("schedules"),
    ]);
    const book = new ExcelJS.Workbook(); book.creator = "DASTRANJ"; book.created = new Date();
    const readme = book.addWorksheet("Export guide");
    readme.addRows([
      ["DASTRANJ complete system export"], ["Classification", "DEMO / SIMULATED DATA — NOT FOR IRCC when marked in source data"],
      ["Timezone", "America/Toronto"], ["Generated at", new Date().toISOString()],
      ["Contents", "All current system tables, raw values, calculation inputs, formula definitions, payroll snapshots, and audit events."],
      ["Formula policy", "The Formula components, Formula versions, Payroll results, and Payroll formula checks tabs expose the same stored inputs and formulas used by the application. Missing values remain blank or Not Available in System."],
      ["Workbook policy", "This is a read-only export snapshot. It is not a payroll recalculation engine and does not invent source data."],
    ]);
    readme.getColumn(1).width = 24; readme.getColumn(2).width = 100; readme.getRow(1).font = { bold: true, size: 15 };
    payloads.forEach((payload, index) => addDataSheet(book, resources[index][0], normalizeRows(payload)));
    const schedules = scheduleBundle && typeof scheduleBundle === "object" ? scheduleBundle as Record<string, unknown> : {};
    addDataSheet(book, "Work schedules", normalizeRows(schedules.schedules));
    addDataSheet(book, "Schedule bundle metadata", [{ source: "GET /api/schedules", payload: schedules }]);
    const payroll = normalizeRows(payloads[9]); const employees = normalizeRows(payloads[0]);
    const rate = new Map(employees.map(employee => [String(employee.id), Number(employee.hourlyRate ?? 0)]));
    const checks = book.addWorksheet("Payroll formula checks");
    checks.addRow(["Employee ID", "Year", "Month", "Hourly rate", "Regular hours", "Overtime hours", "Paid leave hours", "Vacation rate", "Calculated gross", "Recorded gross", "Calculated deductions", "Recorded deductions", "Calculated net", "Recorded net", "Formula snapshot", "Variance gross", "Variance net", "CPP", "CPP2", "EI", "Federal tax", "Ontario tax", "Ontario health premium"]);
    payroll.forEach((item, index) => {
      const row = index + 2, hourly = rate.get(String(item.employeeId)) ?? 0;
      checks.addRow([item.employeeId, item.year, item.month, hourly, item.regularHours, item.overtimeHours, item.paidLeaveHours, .04, null, item.gross, null, item.deductions, null, item.net, display(item.formulaSnapshot)]);
      checks.getCell(`I${row}`).value = { formula: `(D${row}*E${row}+D${row}*F${row}*1.5+D${row}*G${row})*(1+H${row})` };
      checks.getCell(`K${row}`).value = { formula: `R${row}+S${row}+T${row}+U${row}+V${row}+W${row}` };
      checks.getCell(`M${row}`).value = { formula: `I${row}-K${row}` };
      checks.getCell(`P${row}`).value = { formula: `I${row}-J${row}` };
      checks.getCell(`Q${row}`).value = { formula: `M${row}-N${row}` };
    });
    // Deduction components are kept beside the formula so that every recorded amount is traceable.
    payroll.forEach((item, index) => [item.cpp,item.cpp2,item.ei,item.federalTax,item.ontarioTax,item.ontarioHealthPremium].forEach((value, i) => checks.getCell(index + 2, 18 + i).value = Number(value ?? 0)));
    checks.views = [{ state: "frozen", ySplit: 1 }]; checks.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; checks.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17324D" } }; checks.columns.forEach(column => column.width = 18);
    const buffer = Buffer.from(await book.xlsx.writeBuffer());
    res.status(200); res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); res.setHeader("Content-Disposition", "attachment; filename=DASTRANJ_Complete_System_Export.xlsx"); res.setHeader("Cache-Control", "no-store"); res.end(buffer);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
}
