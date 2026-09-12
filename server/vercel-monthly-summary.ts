import type { IncomingMessage, ServerResponse } from "node:http";

type Request = IncomingMessage & { url?: string };
type Response = ServerResponse & {
  status: (code: number) => Response;
  json: (value: unknown) => void;
};
type RecordValue = Record<string, unknown>;

const number = (value: unknown) => Number(value ?? 0) || 0;
const text = (value: unknown) => String(value ?? "");

async function readResource(scriptUrl: string, path: string): Promise<RecordValue[]> {
  const target = new URL(scriptUrl);
  target.searchParams.set("path", path);
  const response = await fetch(target, { redirect: "follow" });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error(`${path}: invalid response`);
  return payload as RecordValue[];
}

/** Builds the legacy monthly dashboard view when the Sheets deployment lacks /monthly. */
export default async function monthlySummary(req: Request, res: Response, scriptUrl: string) {
  const query = new URL(req.url ?? "/api/monthly", "http://vercel.internal").searchParams;
  const year = Number(query.get("year") ?? new Date().getFullYear());
  const month = Number(query.get("month") ?? new Date().getMonth() + 1);
  const prefix = `${year}-${String(month).padStart(2, "0")}`;

  try {
    const [employees, attendance] = await Promise.all([
      readResource(scriptUrl, "employees"),
      readResource(scriptUrl, "attendance"),
    ]);
    const rows = employees
      .filter((employee) => text(employee.employmentStatus) === "active")
      .map((employee) => {
        const entries = attendance.filter(
          (entry) => text(entry.employeeId) === text(employee.id) && text(entry.workDate).startsWith(prefix),
        );
        const status = (entry: RecordValue) => text(entry.overrideStatus || entry.computedStatus || entry.recordStatus);
        return {
          id: text(employee.id),
          fullName: text(employee.fullName),
          personnelCode: text(employee.personnelCode),
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
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    res.json(rows);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
