import cors from "cors";
import ExcelJS from "exceljs";
import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { migrate, pool, transaction } from "./db";
import {
  calculateAttendance,
  evaluatePayroll,
  expressionText,
  isFormulaExpression,
  type FormulaDefinition,
  type FormulaExpression,
} from "./engine";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
// `localhost` and `127.0.0.1` are distinct browser origins.  Allow both for
// local development; deployments can override this with a comma-separated
// WEB_ORIGIN list.
const webOrigins = (process.env.WEB_ORIGIN ??
  "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      // Browsers treat localhost and 127.0.0.1 as different origins. Keep
      // both available for local development even when WEB_ORIGIN contains
      // only one of them, while still rejecting unrelated origins.
      const isLocalWebOrigin =
        origin == null ||
        /^https?:\/\/(localhost|127\.0\.0\.1):3000$/.test(origin);
      callback(null, isLocalWebOrigin || webOrigins.includes(origin ?? ""));
    },
  }),
);
app.use(express.json({ limit: "2mb" }));

const handler =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);
const auditContext = (
  req: express.Request,
  reason?: string,
  batchId?: string,
) => ({
  actorId: String(req.header("x-actor-id") ?? "local-admin"),
  sessionId: String(req.header("x-session-id") ?? "local-session"),
  reason: reason ?? String(req.body?.reason ?? ""),
  batchId,
});
const parseMinute = (value: unknown) => {
  if (value == null || value === "") return null;
  if (typeof value === "number")
    return value < 1 ? Math.round(value * 1440) : Math.round(value);
  const [hour, minute] = String(value).split(":").map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute)
    ? hour * 60 + minute
    : null;
};
const iso = (value: unknown) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value ?? "").slice(0, 10);
const roundWithMode = (value: number, mode: "nearest" | "up" | "down") =>
  mode === "up"
    ? Math.ceil(value)
    : mode === "down"
      ? Math.floor(value)
      : Math.round(value);

type ScheduleRow = {
  id: string;
  start_minute: number;
  end_minute: number;
  break_minutes: number;
  work_days: unknown;
};

async function resolveWorkDay(
  client: PoolClient,
  employeeId: string,
  workDate: string,
) {
  const defaultSchedule = (
    await client.query<ScheduleRow>(
      "SELECT * FROM work_schedules ORDER BY is_default DESC, created_at LIMIT 1",
    )
  ).rows[0];
  if (!defaultSchedule) throw new Error("برنامه کاری تعریف نشده است");
  const override = (
    await client.query<{ schedule_id: string | null; is_holiday: boolean }>(
      `SELECT schedule_id,is_holiday FROM schedule_overrides
       WHERE work_date=$1 AND (employee_id=$2 OR employee_id IS NULL)
       ORDER BY (employee_id IS NOT NULL) DESC LIMIT 1`,
      [workDate, employeeId],
    )
  ).rows[0];
  const schedule = override?.schedule_id
    ? (
        await client.query<ScheduleRow>(
          "SELECT * FROM work_schedules WHERE id=$1",
          [override.schedule_id],
        )
      ).rows[0] ?? defaultSchedule
    : defaultSchedule;
  const calendarHoliday =
    (
      await client.query("SELECT 1 FROM holidays WHERE holiday_date=$1", [
        workDate,
      ])
    ).rowCount !== 0;
  const weekday = new Date(`${workDate.slice(0, 10)}T12:00:00`).getDay();
  const workDays = Array.isArray(schedule.work_days)
    ? schedule.work_days.map(Number)
    : [];
  return {
    schedule,
    holiday: calendarHoliday || Boolean(override?.is_holiday) || !workDays.includes(weekday),
  };
}

app.get(
  "/api/health",
  handler(async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "postgresql" });
  }),
);

app.get(
  "/api/settings",
  handler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT currency,rounding_mode AS "roundingMode",global_values AS "globalValues" FROM general_settings WHERE id=true`,
    );
    res.json(
      rows[0] ?? { currency: "IRR", roundingMode: "nearest", globalValues: {} },
    );
  }),
);
app.put(
  "/api/settings",
  handler(async (req, res) => {
    const d = z.object({
      currency: z.enum(["IRR", "IRT", "USD", "EUR"]),
      roundingMode: z.enum(["nearest", "up", "down"]),
      globalValues: z.record(z.string().min(1).max(80), z.coerce.number().finite()).default({}),
      reason: z.string().min(2),
    }).parse(req.body);
    const row = await transaction(auditContext(req, d.reason), async (c) =>
      (
        await c.query(
          `UPDATE general_settings SET currency=$1,rounding_mode=$2,global_values=$3,updated_at=now() WHERE id=true RETURNING currency,rounding_mode AS "roundingMode",global_values AS "globalValues"`,
          [d.currency, d.roundingMode, JSON.stringify(d.globalValues)],
        )
      ).rows[0],
    );
    res.json(row);
  }),
);

app.get(
  "/api/employees",
  handler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id,personnel_code AS "personnelCode",full_name AS "fullName",employment_status AS "employmentStatus",to_char(start_date,'YYYY-MM-DD') AS "startDate",to_char(end_date,'YYYY-MM-DD') AS "endDate",base_salary::float8 AS "baseSalary",duties,custom_values AS "customValues" FROM employees ORDER BY full_name`,
    );
    res.json(rows.map((row) => {
      const custom = unpackCustomValues(row.customValues);
      return { ...row, customValues: custom.values, customValueKinds: custom.kinds };
    }));
  }),
);

type CustomValueKind = "earning" | "deduction";
function unpackCustomValues(raw: unknown): { values: Record<string, number>; kinds: Record<string, CustomValueKind> } {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const valuesSource = source.values && typeof source.values === "object" && !Array.isArray(source.values)
    ? source.values as Record<string, unknown>
    : source;
  const kindsSource = source.kinds && typeof source.kinds === "object" && !Array.isArray(source.kinds)
    ? source.kinds as Record<string, unknown>
    : {};
  const values = Object.fromEntries(Object.entries(valuesSource).filter(([, value]) => typeof value === "number").map(([key, value]) => [key, value as number]));
  const kinds = Object.fromEntries(Object.entries(kindsSource).filter(([key, kind]) => key in values && (kind === "earning" || kind === "deduction"))) as Record<string, CustomValueKind>;
  return { values, kinds };
}

const employeeInput = z.object({
  personnelCode: z.string().min(1),
  fullName: z.string().min(2),
  employmentStatus: z.string().default("active"),
  startDate: z.string().min(10),
  endDate: z.string().nullable().optional(),
  baseSalary: z.coerce.number().nonnegative(),
  duties: z.string().trim().min(2),
  customValues: z.record(z.string(), z.coerce.number()).default({}),
  customValueKinds: z.record(z.string(), z.enum(["earning", "deduction"])).default({}),
});
app.post(
  "/api/employees",
  handler(async (req, res) => {
    const data = employeeInput.parse(req.body);
    const row = await transaction(
      auditContext(req),
      async (c) =>
        (
          await c.query(
            `INSERT INTO employees(personnel_code,full_name,employment_status,start_date,end_date,base_salary,duties,custom_values) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
              data.personnelCode,
              data.fullName,
              data.employmentStatus,
              data.startDate,
              data.endDate ?? null,
              data.baseSalary,
              data.duties,
              { values: data.customValues, kinds: data.customValueKinds },
            ],
          )
        ).rows[0],
    );
    res.status(201).json(row);
  }),
);
app.put(
  "/api/employees/:id",
  handler(async (req, res) => {
    const data = employeeInput.parse(req.body);
    const row = await transaction(
      auditContext(req),
      async (c) =>
        (
          await c.query(
            `UPDATE employees SET personnel_code=$1,full_name=$2,employment_status=$3,start_date=$4,end_date=$5,base_salary=$6,duties=$7,custom_values=$8,updated_at=now() WHERE id=$9 RETURNING *`,
            [
              data.personnelCode,
              data.fullName,
              data.employmentStatus,
              data.startDate,
              data.endDate ?? null,
              data.baseSalary,
              data.duties,
              { values: data.customValues, kinds: data.customValueKinds },
              req.params.id,
            ],
          )
        ).rows[0],
    );
    if (!row) return res.status(404).json({ error: "کارمند یافت نشد" });
    res.json(row);
  }),
);
app.delete(
  "/api/employees/:id",
  handler(async (req, res) => {
    await transaction(
      auditContext(req, String(req.body?.reason ?? "حذف کارمند")),
      async (c) => {
        const locked = await c.query(
          `SELECT 1 FROM payroll_results r JOIN payroll_periods p ON p.id=r.period_id WHERE r.employee_id=$1 AND p.status='locked' LIMIT 1`,
          [req.params.id],
        );
        if (locked.rowCount)
          throw Object.assign(
            new Error("کارمند در دوره نهایی‌شده استفاده شده و قابل حذف نیست"),
            { status: 409 },
          );
        await c.query("DELETE FROM employees WHERE id=$1", [req.params.id]);
      },
    );
    res.status(204).end();
  }),
);

app.get(
  "/api/schedules",
  handler(async (_req, res) => {
    const [schedules, holidays, leaves, overrides] = await Promise.all([
      pool.query(
        `SELECT id,name,start_minute AS "startMinute",end_minute AS "endMinute",break_minutes AS "breakMinutes",work_days AS "workDays",is_default AS "isDefault" FROM work_schedules ORDER BY is_default DESC,name`,
      ),
      pool.query(
        `SELECT id,to_char(holiday_date,'YYYY-MM-DD') AS date,title FROM holidays ORDER BY holiday_date`,
      ),
      pool.query(
        `SELECT id,name,unit,is_paid AS "isPaid" FROM leave_types ORDER BY name`,
      ),
      pool.query(
        `SELECT to_char(so.work_date,'YYYY-MM-DD') AS date,so.schedule_id AS "scheduleId",so.is_holiday AS "isHoliday",ws.name AS "scheduleName" FROM schedule_overrides so LEFT JOIN work_schedules ws ON ws.id=so.schedule_id WHERE so.employee_id IS NULL ORDER BY so.work_date`,
      ),
    ]);
    res.json({
      schedules: schedules.rows,
      holidays: holidays.rows,
      leaveTypes: leaves.rows,
      overrides: overrides.rows,
    });
  }),
);
app.put(
  "/api/schedules/:id",
  handler(async (req, res) => {
    const d = z
      .object({
        name: z.string().min(2),
        startMinute: z.coerce.number().int().min(0).max(1439),
        endMinute: z.coerce.number().int().min(0).max(1439),
        breakMinutes: z.coerce.number().int().min(0),
        workDays: z.array(z.number().int().min(0).max(6)).min(1),
        isDefault: z.boolean().default(false),
      })
      .parse(req.body);
    const row = await transaction(
      auditContext(req, "تغییر روزهای کاری"),
      async (c) => {
        if (d.isDefault)
          await c.query(
            "UPDATE work_schedules SET is_default=false WHERE is_default=true AND id<>$1",
            [req.params.id],
          );
        return (
          await c.query(
            `UPDATE work_schedules SET name=$1,start_minute=$2,end_minute=$3,break_minutes=$4,work_days=$5,is_default=$6,updated_at=now() WHERE id=$7 RETURNING *`,
            [
              d.name,
              d.startMinute,
              d.endMinute,
              d.breakMinutes,
              JSON.stringify(d.workDays),
              d.isDefault,
              req.params.id,
            ],
          )
        ).rows[0];
      },
    );
    if (!row) return res.status(404).json({ error: "شیفت یافت نشد" });
    res.json(row);
  }),
);
app.post(
  "/api/schedules",
  handler(async (req, res) => {
    const d = z
      .object({
        name: z.string().min(2),
        startMinute: z.coerce.number().int().min(0).max(1439),
        endMinute: z.coerce.number().int().min(0).max(1439),
        breakMinutes: z.coerce.number().int().min(0),
        workDays: z.array(z.number().int()).min(1),
        isDefault: z.boolean().default(false),
      })
      .parse(req.body);
    const row = await transaction(auditContext(req), async (c) => {
      if (d.isDefault)
        await c.query(
          "UPDATE work_schedules SET is_default=false WHERE is_default=true",
        );
      return (
        await c.query(
          `INSERT INTO work_schedules(name,start_minute,end_minute,break_minutes,work_days,is_default) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            d.name,
            d.startMinute,
            d.endMinute,
            d.breakMinutes,
            JSON.stringify(d.workDays),
            d.isDefault,
          ],
        )
      ).rows[0];
    });
    res.status(201).json(row);
  }),
);
app.post(
  "/api/leave-types",
  handler(async (req, res) => {
    const d = z
      .object({
        name: z.string().min(2),
        unit: z.enum(["hourly", "daily"]),
        isPaid: z.boolean(),
      })
      .parse(req.body);
    const row = await transaction(
      auditContext(req),
      async (c) =>
        (
          await c.query(
            "INSERT INTO leave_types(name,unit,is_paid) VALUES($1,$2,$3) RETURNING *",
            [d.name, d.unit, d.isPaid],
          )
        ).rows[0],
    );
    res.status(201).json(row);
  }),
);
app.post(
  "/api/holidays",
  handler(async (req, res) => {
    const d = z
      .object({ date: z.string().min(10), title: z.string().min(2) })
      .parse(req.body);
    const row = await transaction(
      auditContext(req),
      async (c) =>
        (
          await c.query(
            "INSERT INTO holidays(holiday_date,title) VALUES($1,$2) RETURNING *",
            [d.date, d.title],
          )
        ).rows[0],
    );
    res.status(201).json(row);
  }),
);
app.post(
  "/api/schedule-overrides",
  handler(async (req, res) => {
    const d = z
      .object({
        employeeId: z.string().uuid().nullable(),
        workDate: z.string().min(10),
        scheduleId: z.string().uuid().nullable(),
        isHoliday: z.boolean(),
        reason: z.string().min(2),
      })
      .parse(req.body);
    const row = await transaction(auditContext(req, d.reason), async (c) => {
      await c.query(
        "DELETE FROM schedule_overrides WHERE employee_id IS NOT DISTINCT FROM $1 AND work_date=$2",
        [d.employeeId, d.workDate],
      );
      if (d.employeeId === null) {
        if (d.isHoliday) {
          await c.query(
            "INSERT INTO holidays(holiday_date,title) VALUES($1,$2) ON CONFLICT(holiday_date) DO UPDATE SET title=EXCLUDED.title,updated_at=now()",
            [d.workDate, `تعطیلی تقویمی: ${d.reason}`],
          );
        } else {
          await c.query("DELETE FROM holidays WHERE holiday_date=$1", [
            d.workDate,
          ]);
        }
      }
      return (
        await c.query(
          "INSERT INTO schedule_overrides(employee_id,work_date,schedule_id,is_holiday) VALUES($1,$2,$3,$4) RETURNING *",
          [d.employeeId, d.workDate, d.scheduleId, d.isHoliday],
        )
      ).rows[0];
    });
    res.status(201).json(row);
  }),
);

app.get(
  "/api/attendance",
  handler(async (req, res) => {
    const date = String(
      req.query.date ?? new Date().toISOString().slice(0, 10),
    );
    const { rows } = await pool.query(
      `SELECT a.*,to_char(a.work_date,'YYYY-MM-DD') AS work_date,e.full_name AS "fullName",e.personnel_code AS "personnelCode",lt.name AS "leaveType" FROM attendance_entries a JOIN employees e ON e.id=a.employee_id LEFT JOIN leave_types lt ON lt.id=a.leave_type_id WHERE a.work_date=$1 ORDER BY e.full_name`,
      [date],
    );
    res.json(rows);
  }),
);
const attendanceInput = z.object({
  employeeId: z.string().uuid(),
  workDate: z.string().min(10),
  checkInMinute: z.number().int().nullable().optional(),
  checkOutMinute: z.number().int().nullable().optional(),
  breakMinutes: z.number().int().min(0).default(0),
  leaveTypeId: z.string().uuid().nullable().optional(),
  leaveMinutes: z.number().int().min(0).default(0),
  overrideStatus: z
    .enum(["present", "absent", "leave", "holiday", "incomplete"])
    .nullable()
    .optional(),
  overrideReason: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
app.post(
  "/api/attendance",
  handler(async (req, res) => {
    const d = attendanceInput.parse(req.body);
    if (d.overrideStatus && !d.overrideReason)
      return res
        .status(400)
        .json({ error: "برای اصلاح دستی وضعیت، ثبت دلیل الزامی است" });
    const row = await transaction(
      auditContext(req, d.overrideReason ?? undefined),
      async (c) => {
        const { schedule, holiday } = await resolveWorkDay(
          c,
          d.employeeId,
          d.workDate,
        );
        const calc = calculateAttendance({
          checkInMinute: d.checkInMinute,
          checkOutMinute: d.checkOutMinute,
          breakMinutes: d.breakMinutes,
          leaveMinutes: d.leaveMinutes,
          scheduleStart: schedule.start_minute,
          scheduleEnd: schedule.end_minute,
          holiday,
        });
        return (
          await c.query(
            `INSERT INTO attendance_entries(employee_id,work_date,check_in_minute,check_out_minute,break_minutes,leave_type_id,leave_minutes,actual_minutes,required_minutes,delay_minutes,early_leave_minutes,deficit_minutes,overtime_minutes,computed_status,override_status,override_reason,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(employee_id,work_date) DO UPDATE SET check_in_minute=EXCLUDED.check_in_minute,check_out_minute=EXCLUDED.check_out_minute,break_minutes=EXCLUDED.break_minutes,leave_type_id=EXCLUDED.leave_type_id,leave_minutes=EXCLUDED.leave_minutes,actual_minutes=EXCLUDED.actual_minutes,required_minutes=EXCLUDED.required_minutes,delay_minutes=EXCLUDED.delay_minutes,early_leave_minutes=EXCLUDED.early_leave_minutes,deficit_minutes=EXCLUDED.deficit_minutes,overtime_minutes=EXCLUDED.overtime_minutes,computed_status=EXCLUDED.computed_status,override_status=EXCLUDED.override_status,override_reason=EXCLUDED.override_reason,notes=EXCLUDED.notes,updated_at=now() RETURNING *`,
            [
              d.employeeId,
              d.workDate,
              d.checkInMinute ?? null,
              d.checkOutMinute ?? null,
              d.breakMinutes,
              d.leaveTypeId ?? null,
              d.leaveMinutes,
              calc.actualMinutes,
              calc.requiredMinutes,
              calc.delayMinutes,
              calc.earlyLeaveMinutes,
              calc.deficitMinutes,
              calc.overtimeMinutes,
              calc.status,
              d.overrideStatus ?? null,
              d.overrideReason ?? null,
              d.notes ?? null,
            ],
          )
        ).rows[0];
      },
    );
    res.json(row);
  }),
);

app.get(
  "/api/monthly",
  handler(async (req, res) => {
    const year = Number(req.query.year ?? new Date().getFullYear()),
      month = Number(req.query.month ?? new Date().getMonth() + 1);
    const { rows } = await pool.query(
      `WITH default_schedule AS (
         SELECT id,start_minute,end_minute,break_minutes,work_days
         FROM work_schedules ORDER BY is_default DESC,created_at LIMIT 1
       ), calendar AS (
         SELECT e.id AS employee_id, d::date AS work_date,
           COALESCE(personal.schedule_id,global.schedule_id,default_schedule.id) AS schedule_id,
           COALESCE(personal.is_holiday,global.is_holiday,false) AS is_holiday,
           EXISTS(SELECT 1 FROM holidays h WHERE h.holiday_date=d::date) AS calendar_holiday
         FROM employees e CROSS JOIN default_schedule
         CROSS JOIN generate_series(make_date($1,$2,1), (make_date($1,$2,1) + INTERVAL '1 month - 1 day')::date, INTERVAL '1 day') d
         LEFT JOIN schedule_overrides personal ON personal.employee_id=e.id AND personal.work_date=d::date
         LEFT JOIN schedule_overrides global ON global.employee_id IS NULL AND global.work_date=d::date
         WHERE e.employment_status='active'
       ), expected AS (
         SELECT calendar.employee_id,
           COUNT(*) FILTER(WHERE NOT calendar.is_holiday AND NOT calendar.calendar_holiday AND ws.work_days @> jsonb_build_array(EXTRACT(DOW FROM calendar.work_date)::int))::int AS required_days,
           COALESCE(SUM(CASE WHEN NOT calendar.is_holiday AND NOT calendar.calendar_holiday AND ws.work_days @> jsonb_build_array(EXTRACT(DOW FROM calendar.work_date)::int) THEN ((ws.end_minute-ws.start_minute+1440)%1440)-ws.break_minutes ELSE 0 END),0)::int AS scheduled_minutes
         FROM calendar JOIN work_schedules ws ON ws.id=calendar.schedule_id GROUP BY calendar.employee_id
       )
       SELECT e.id,e.full_name AS "fullName",e.personnel_code AS "personnelCode",COALESCE(expected.required_days,0)::int AS "requiredDays",COALESCE(expected.scheduled_minutes,0)::int AS "scheduledMinutes",COUNT(a.id)::int AS "recordedDays",COUNT(*) FILTER (WHERE COALESCE(a.override_status,a.computed_status)='present')::int AS "presentDays",COUNT(*) FILTER (WHERE COALESCE(a.override_status,a.computed_status)='absent')::int AS "absentDays",COUNT(*) FILTER (WHERE COALESCE(a.override_status,a.computed_status)='leave')::int AS "leaveDays",COALESCE(SUM(a.actual_minutes),0)::int AS "actualMinutes",COALESCE(SUM(a.required_minutes),0)::int AS "requiredMinutes",COALESCE(SUM(a.leave_minutes),0)::int AS "leaveMinutes",COALESCE(SUM(a.leave_minutes) FILTER (WHERE lt.is_paid),0)::int AS "paidLeaveMinutes",COALESCE(SUM(a.leave_minutes) FILTER (WHERE NOT lt.is_paid),0)::int AS "unpaidLeaveMinutes",COALESCE(SUM(a.deficit_minutes),0)::int AS "deficitMinutes",COALESCE(SUM(a.overtime_minutes),0)::int AS "overtimeMinutes" FROM employees e LEFT JOIN expected ON expected.employee_id=e.id LEFT JOIN attendance_entries a ON a.employee_id=e.id AND EXTRACT(YEAR FROM a.work_date)=$1 AND EXTRACT(MONTH FROM a.work_date)=$2 LEFT JOIN leave_types lt ON lt.id=a.leave_type_id WHERE e.employment_status='active' GROUP BY e.id,expected.required_days,expected.scheduled_minutes ORDER BY e.full_name`,
      [year, month],
    );
    res.json(rows);
  }),
);

app.get(
  "/api/formulas",
  handler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT c.id,c.code,c.name,c.kind,v.id AS "versionId",v.version,v.expression,v.expression_text AS "expressionText" FROM formula_components c LEFT JOIN formula_versions v ON v.id=c.active_version_id ORDER BY c.kind,c.name`,
    );
    res.json(rows);
  }),
);
const formulaInput = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(2),
  kind: z.enum(["earning", "deduction", "net"]),
  expression: z.custom<FormulaExpression>(isFormulaExpression, "ساختار فرمول معتبر نیست"),
});
app.post(
  "/api/formulas",
  handler(async (req, res) => {
    const d = formulaInput.parse(req.body);
    const row = await transaction(auditContext(req), async (c) => {
      let component = (
        await c.query("SELECT * FROM formula_components WHERE code=$1", [
          d.code,
        ])
      ).rows[0];
      if (!component)
        component = (
          await c.query(
            "INSERT INTO formula_components(code,name,kind) VALUES($1,$2,$3) RETURNING *",
            [d.code, d.name, d.kind],
          )
        ).rows[0];
      else
        await c.query(
          "UPDATE formula_components SET name=$1,kind=$2,updated_at=now() WHERE id=$3",
          [d.name, d.kind, component.id],
        );
      const version = Number(
        (
          await c.query(
            "SELECT COALESCE(MAX(version),0)+1 AS version FROM formula_versions WHERE component_id=$1",
            [component.id],
          )
        ).rows[0].version,
      );
      const saved = (
        await c.query(
          "INSERT INTO formula_versions(component_id,version,expression,expression_text) VALUES($1,$2,$3,$4) RETURNING *",
          [component.id, version, d.expression, expressionText(d.expression)],
        )
      ).rows[0];
      await c.query(
        "UPDATE formula_components SET active_version_id=$1 WHERE id=$2",
        [saved.id, component.id],
      );
      return saved;
    });
    res.status(201).json(row);
  }),
);
app.post(
  "/api/formulas/preview",
  handler(async (req, res) => {
    const d = z
      .object({
        definitions: z.array(formulaInput),
        inputs: z.record(z.string(), z.number()),
      })
      .parse(req.body);
    res.json(evaluatePayroll(d.definitions, d.inputs));
  }),
);

app.post(
  "/api/payroll/process",
  handler(async (req, res) => {
    const { year, month } = z
      .object({
        year: z.number().int(),
        month: z.number().int().min(1).max(12),
      })
      .parse(req.body);
    const result = await transaction(
      auditContext(req, "پردازش حقوق"),
      async (c) => {
        let period = (
          await c.query(
            "SELECT * FROM payroll_periods WHERE year=$1 AND month=$2",
            [year, month],
          )
        ).rows[0];
        if (period?.status === "locked")
          throw Object.assign(
            new Error("دوره نهایی شده و قابل محاسبه مجدد نیست"),
            { status: 409 },
          );
        if (!period)
          period = (
            await c.query(
              "INSERT INTO payroll_periods(year,month,status) VALUES($1,$2,'processing') RETURNING *",
              [year, month],
            )
          ).rows[0];
        const formulas = (
          await c.query(
            `SELECT c.code,c.name,c.kind,v.expression FROM formula_components c JOIN formula_versions v ON v.id=c.active_version_id ORDER BY c.created_at`,
          )
        ).rows as FormulaDefinition[];
        const settings = (
          await c.query<{
            currency: string;
            rounding_mode: "nearest" | "up" | "down";
            global_values: Record<string, number>;
          }>(
            "SELECT currency,rounding_mode,global_values FROM general_settings WHERE id=true",
          )
        ).rows[0] ?? {
          currency: "IRR",
          rounding_mode: "nearest" as const,
          global_values: {},
        };
        const summaries = (
          await c.query(
            `SELECT e.id,e.base_salary::float8 AS base_salary,e.custom_values,COALESCE(SUM(a.actual_minutes),0)::int AS actual_minutes,COALESCE(SUM(a.required_minutes),0)::int AS required_minutes,COALESCE(SUM(a.leave_minutes),0)::int AS leave_minutes,COALESCE(SUM(a.leave_minutes) FILTER (WHERE lt.is_paid),0)::int AS paid_leave_minutes,COALESCE(SUM(a.leave_minutes) FILTER (WHERE NOT lt.is_paid),0)::int AS unpaid_leave_minutes,COALESCE(SUM(a.deficit_minutes),0)::int AS deficit_minutes,COALESCE(SUM(a.overtime_minutes),0)::int AS overtime_minutes,COUNT(*) FILTER(WHERE COALESCE(a.override_status,a.computed_status)='present')::int AS present_days,COUNT(*) FILTER(WHERE COALESCE(a.override_status,a.computed_status)='absent')::int AS absent_days FROM employees e LEFT JOIN attendance_entries a ON a.employee_id=e.id AND EXTRACT(YEAR FROM a.work_date)=$1 AND EXTRACT(MONTH FROM a.work_date)=$2 LEFT JOIN leave_types lt ON lt.id=a.leave_type_id WHERE e.employment_status='active' GROUP BY e.id`,
            [year, month],
          )
        ).rows;
        let processed = 0;
        for (const s of summaries) {
          const inputs = {
            base_salary: Number(s.base_salary),
            actual_minutes: s.actual_minutes,
            required_minutes: s.required_minutes,
            leave_minutes: s.leave_minutes,
            paid_leave_minutes: s.paid_leave_minutes,
            unpaid_leave_minutes: s.unpaid_leave_minutes,
            deficit_minutes: s.deficit_minutes,
            overtime_minutes: s.overtime_minutes,
            present_days: s.present_days,
            absent_days: s.absent_days,
            ...settings.global_values,
            ...unpackCustomValues(s.custom_values).values,
          };
          const calculated = evaluatePayroll(formulas, inputs);
          const earnings = roundWithMode(calculated.earnings, settings.rounding_mode);
          const deductions = roundWithMode(calculated.deductions, settings.rounding_mode);
          const netPay = calculated.trace.some((item) => item.kind === "net")
            ? roundWithMode(calculated.netPay, settings.rounding_mode)
            : earnings - deductions;
          await c.query(
            `INSERT INTO payroll_results(period_id,employee_id,inputs,component_results,earnings,deductions,net_pay) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(period_id,employee_id) DO UPDATE SET inputs=EXCLUDED.inputs,component_results=EXCLUDED.component_results,earnings=EXCLUDED.earnings,deductions=EXCLUDED.deductions,net_pay=EXCLUDED.net_pay,calculated_at=now()`,
            [
              period.id,
              s.id,
              inputs,
              JSON.stringify(calculated.trace),
              earnings,
              deductions,
              netPay,
            ],
          );
          processed++;
        }
        await c.query(
          "UPDATE payroll_periods SET status='draft',updated_at=now() WHERE id=$1",
          [period.id],
        );
        return { periodId: period.id, processed };
      },
    );
    res.json(result);
  }),
);
app.get(
  "/api/payroll/periods",
  handler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT p.id,p.year,p.month,p.status,p.locked_at AS "lockedAt",COUNT(r.id)::int AS "resultCount",COALESCE(SUM(r.earnings),0)::float8 AS earnings,COALESCE(SUM(r.deductions),0)::float8 AS deductions,COALESCE(SUM(r.net_pay),0)::float8 AS "netPay" FROM payroll_periods p LEFT JOIN payroll_results r ON r.period_id=p.id GROUP BY p.id ORDER BY p.year DESC,p.month DESC`,
    );
    res.json(rows);
  }),
);
app.get(
  "/api/payroll/results",
  handler(async (req, res) => {
    const year = Number(req.query.year ?? new Date().getFullYear());
    const month = Number(req.query.month ?? new Date().getMonth() + 1);
    const { rows } = await pool.query(
      `SELECT r.id,p.id AS "periodId",p.year,p.month,p.status,e.full_name AS "fullName",e.personnel_code AS "personnelCode",r.inputs,r.component_results AS "componentResults",r.earnings::float8,r.deductions::float8,r.net_pay::float8 AS "netPay",r.calculated_at AS "calculatedAt" FROM payroll_results r JOIN payroll_periods p ON p.id=r.period_id JOIN employees e ON e.id=r.employee_id WHERE p.year=$1 AND p.month=$2 ORDER BY e.full_name`,
      [year, month],
    );
    res.json(rows);
  }),
);
app.post(
  "/api/payroll/:id/lock",
  handler(async (req, res) => {
    const row = await transaction(
      auditContext(req, "نهایی‌سازی دوره"),
      async (c) =>
        (
          await c.query(
            `UPDATE payroll_periods p SET status='locked',locked_at=now(),snapshot=jsonb_build_object('period',to_jsonb(p),'settings',(SELECT to_jsonb(s) FROM general_settings s WHERE s.id=true),'schedules',(SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]') FROM work_schedules s),'leaveTypes',(SELECT COALESCE(jsonb_agg(to_jsonb(lt)),'[]') FROM leave_types lt),'holidays',(SELECT COALESCE(jsonb_agg(to_jsonb(h)),'[]') FROM holidays h WHERE EXTRACT(YEAR FROM h.holiday_date)=p.year AND EXTRACT(MONTH FROM h.holiday_date)=p.month),'overrides',(SELECT COALESCE(jsonb_agg(to_jsonb(so)),'[]') FROM schedule_overrides so WHERE EXTRACT(YEAR FROM so.work_date)=p.year AND EXTRACT(MONTH FROM so.work_date)=p.month),'formulas',(SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]') FROM (SELECT c.code,c.name,c.kind,v.version,v.expression FROM formula_components c JOIN formula_versions v ON v.id=c.active_version_id) x),'attendance',(SELECT COALESCE(jsonb_agg(to_jsonb(a)),'[]') FROM attendance_entries a JOIN payroll_results r ON r.employee_id=a.employee_id WHERE r.period_id=p.id AND EXTRACT(YEAR FROM a.work_date)=p.year AND EXTRACT(MONTH FROM a.work_date)=p.month),'employees',(SELECT COALESCE(jsonb_agg(to_jsonb(e)),'[]') FROM employees e JOIN payroll_results r ON r.employee_id=e.id WHERE r.period_id=p.id),'results',(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM payroll_results r WHERE r.period_id=p.id)),updated_at=now() WHERE id=$1 AND status<>'locked' RETURNING *`,
            [req.params.id],
          )
        ).rows[0],
    );
    res.json(row);
  }),
);
app.post(
  "/api/payroll/:id/reopen",
  handler(async (req, res) => {
    if (!req.body?.reason)
      return res.status(400).json({ error: "دلیل بازگشایی الزامی است" });
    const row = await transaction(
      auditContext(req, req.body.reason),
      async (c) =>
        (
          await c.query(
            "UPDATE payroll_periods SET status='draft',locked_at=NULL,updated_at=now() WHERE id=$1 RETURNING *",
            [req.params.id],
          )
        ).rows[0],
    );
    res.json(row);
  }),
);

app.get(
  "/api/audit",
  handler(async (req, res) => {
    const values: unknown[] = [];
    const where: string[] = [];
    for (const [key, column] of [
      ["entityType", "entity_type"],
      ["action", "action"],
      ["actorId", "actor_id"],
    ] as const) {
      if (req.query[key]) {
        values.push(req.query[key]);
        where.push(`${column}=$${values.length}`);
      }
    }
    if (req.query.q) {
      values.push(`%${req.query.q}%`);
      where.push(
        `(entity_id ILIKE $${values.length} OR before_value::text ILIKE $${values.length} OR after_value::text ILIKE $${values.length})`,
      );
    }
    if (req.query.from) {
      values.push(String(req.query.from));
      where.push(`occurred_at >= $${values.length}::date`);
    }
    if (req.query.to) {
      values.push(String(req.query.to));
      where.push(`occurred_at < ($${values.length}::date + INTERVAL '1 day')`);
    }
    const { rows } = await pool.query(
      `SELECT id,occurred_at AS "occurredAt",actor_id AS "actorId",action,entity_type AS "entityType",entity_id AS "entityId",before_value AS "beforeValue",after_value AS "afterValue",reason,session_id AS "sessionId",batch_id AS "batchId" FROM audit_logs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY occurred_at DESC LIMIT 500`,
      values,
    );
    res.json(rows);
  }),
);

async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "کارا";
  wb.created = new Date();
  const add = (
    name: string,
    columns: { header: string; key: string; width: number }[],
    rows: Record<string, unknown>[],
  ) => {
    const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true }] });
    ws.columns = columns;
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1D4ED8" },
    };
    ws.autoFilter = { from: "A1", to: { row: 1, column: columns.length } };
    return ws;
  };
  const employees = (
    await pool.query(
      `SELECT personnel_code,full_name,employment_status,start_date,end_date,base_salary::float8 FROM employees ORDER BY full_name`,
    )
  ).rows;
  add(
    "کارمندان",
    [
      { header: "کد پرسنلی", key: "personnel_code", width: 16 },
      { header: "نام", key: "full_name", width: 24 },
      { header: "وضعیت", key: "employment_status", width: 14 },
      { header: "تاریخ شروع", key: "start_date", width: 15 },
      { header: "تاریخ پایان", key: "end_date", width: 15 },
      { header: "حقوق پایه", key: "base_salary", width: 18 },
    ],
    employees,
  );
  const daily = (
    await pool.query(
      `SELECT e.personnel_code,e.full_name,a.work_date,a.check_in_minute,a.check_out_minute,a.break_minutes,a.actual_minutes,a.leave_minutes,a.deficit_minutes,a.overtime_minutes,COALESCE(a.override_status,a.computed_status) status FROM attendance_entries a JOIN employees e ON e.id=a.employee_id ORDER BY a.work_date,e.full_name`,
    )
  ).rows;
  const dailySheet = add(
    "حضور روزانه",
    [
      { header: "کد", key: "personnel_code", width: 14 },
      { header: "نام", key: "full_name", width: 24 },
      { header: "تاریخ", key: "work_date", width: 14 },
      { header: "ورود", key: "check_in_minute", width: 14 },
      { header: "خروج", key: "check_out_minute", width: 14 },
      { header: "استراحت", key: "break_minutes", width: 12 },
      { header: "کار واقعی", key: "actual_minutes", width: 12 },
      { header: "مرخصی", key: "leave_minutes", width: 12 },
      { header: "کسری", key: "deficit_minutes", width: 12 },
      { header: "اضافه‌کاری", key: "overtime_minutes", width: 14 },
      { header: "وضعیت", key: "status", width: 14 },
    ],
    daily.map((row) => ({
      ...row,
      check_in_minute: row.check_in_minute == null ? null : Number(row.check_in_minute) / 1440,
      check_out_minute: row.check_out_minute == null ? null : Number(row.check_out_minute) / 1440,
      break_minutes: Number(row.break_minutes) / 1440,
      actual_minutes: Number(row.actual_minutes) / 1440,
      leave_minutes: Number(row.leave_minutes) / 1440,
      deficit_minutes: Number(row.deficit_minutes) / 1440,
      overtime_minutes: Number(row.overtime_minutes) / 1440,
    })),
  );
  for (let i = 4; i <= 10; i++) dailySheet.getColumn(i).numFmt = i < 6 ? "hh:mm" : "[h]:mm";
  const monthly = (
    await pool.query(
      `SELECT EXTRACT(YEAR FROM a.work_date)::int AS year,EXTRACT(MONTH FROM a.work_date)::int AS month,e.personnel_code,e.full_name,COUNT(a.id)::int recorded_days,COUNT(*) FILTER(WHERE COALESCE(a.override_status,a.computed_status)='present')::int present_days,COUNT(*) FILTER(WHERE COALESCE(a.override_status,a.computed_status)='absent')::int absent_days,COALESCE(SUM(a.actual_minutes),0)::int actual_minutes,COALESCE(SUM(a.leave_minutes),0)::int leave_minutes,COALESCE(SUM(a.deficit_minutes),0)::int deficit_minutes,COALESCE(SUM(a.overtime_minutes),0)::int overtime_minutes FROM attendance_entries a JOIN employees e ON e.id=a.employee_id GROUP BY EXTRACT(YEAR FROM a.work_date),EXTRACT(MONTH FROM a.work_date),e.id,e.personnel_code,e.full_name ORDER BY EXTRACT(YEAR FROM a.work_date) DESC,EXTRACT(MONTH FROM a.work_date) DESC,e.full_name`,
    )
  ).rows;
  add(
    "خلاصه ماهانه",
    [
      { header: "سال", key: "year", width: 10 },
      { header: "ماه", key: "month", width: 10 },
      { header: "کد", key: "personnel_code", width: 14 },
      { header: "نام", key: "full_name", width: 24 },
      { header: "روز ثبت", key: "recorded_days", width: 12 },
      { header: "حضور", key: "present_days", width: 10 },
      { header: "غیبت", key: "absent_days", width: 10 },
      { header: "کار واقعی", key: "actual_minutes", width: 13 },
      { header: "مرخصی", key: "leave_minutes", width: 12 },
      { header: "کسری", key: "deficit_minutes", width: 12 },
      { header: "اضافه‌کاری", key: "overtime_minutes", width: 14 },
    ],
    monthly,
  );
  const results = (
    await pool.query(
      `SELECT p.year,p.month,e.personnel_code,e.full_name,r.earnings::float8,r.deductions::float8,r.net_pay::float8,r.component_results FROM payroll_results r JOIN payroll_periods p ON p.id=r.period_id JOIN employees e ON e.id=r.employee_id ORDER BY p.year DESC,p.month DESC,e.full_name`,
    )
  ).rows;
  const pay = add(
    "فیش حقوق",
    [
      { header: "سال", key: "year", width: 10 },
      { header: "ماه", key: "month", width: 10 },
      { header: "کد", key: "personnel_code", width: 14 },
      { header: "نام", key: "full_name", width: 24 },
      { header: "پرداخت‌ها", key: "earnings", width: 18 },
      { header: "کسورات", key: "deductions", width: 18 },
      { header: "خالص", key: "net_pay", width: 18 },
    ],
    results,
  );
  for (let i = 2; i <= results.length + 1; i++)
    pay.getCell(`G${i}`).value = {
      formula: `E${i}-F${i}`,
      result: results[i - 2].net_pay,
    };
  const formulas = (
    await pool.query(
      `SELECT c.code,c.name,c.kind,v.version,v.expression_text FROM formula_components c JOIN formula_versions v ON v.id=c.active_version_id ORDER BY c.kind,c.name`,
    )
  ).rows;
  add(
    "فرمول‌ها",
    [
      { header: "کد", key: "code", width: 20 },
      { header: "نام", key: "name", width: 24 },
      { header: "نوع", key: "kind", width: 14 },
      { header: "نسخه", key: "version", width: 10 },
      { header: "فرمول", key: "expression_text", width: 48 },
    ],
    formulas,
  );
  const audits = (
    await pool.query(
      `SELECT occurred_at,actor_id,action,entity_type,entity_id,reason,session_id,batch_id,before_value::text,after_value::text FROM audit_logs ORDER BY occurred_at DESC`,
    )
  ).rows;
  add(
    "Audit Log",
    [
      { header: "زمان", key: "occurred_at", width: 24 },
      { header: "مدیر", key: "actor_id", width: 16 },
      { header: "عملیات", key: "action", width: 12 },
      { header: "موجودیت", key: "entity_type", width: 22 },
      { header: "شناسه", key: "entity_id", width: 38 },
      { header: "دلیل", key: "reason", width: 28 },
      { header: "نشست", key: "session_id", width: 18 },
      { header: "Batch", key: "batch_id", width: 38 },
      { header: "قبل", key: "before_value", width: 50 },
      { header: "بعد", key: "after_value", width: 50 },
    ],
    audits,
  );
  return wb;
}
app.get(
  "/api/export.xlsx",
  handler(async (_req, res) => {
    const wb = await buildWorkbook();
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=kara-payroll.xlsx",
    );
    res.send(Buffer.from(buffer));
  }),
);
app.get(
  "/api/import/template.xlsx",
  handler(async (_req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("ورود حضور", { views: [{ rightToLeft: true }] });
    const employees = (
      await pool.query<{ personnel_code: string }>("SELECT personnel_code FROM employees ORDER BY personnel_code")
    ).rows;
    const leaveTypes = (
      await pool.query<{ name: string }>("SELECT name FROM leave_types ORDER BY name")
    ).rows;
    ws.columns = [
      { header: "کد پرسنلی", key: "code", width: 18 },
      { header: "تاریخ", key: "date", width: 16 },
      { header: "ورود", key: "in", width: 14 },
      { header: "خروج", key: "out", width: 14 },
      { header: "استراحت", key: "break", width: 14 },
      { header: "مرخصی", key: "leave", width: 14 },
      { header: "نوع مرخصی", key: "leaveType", width: 18 },
      { header: "کنترل تکرار", key: "duplicate", width: 16 },
    ];
    ws.addRow({
      code: "EMP-1001",
      date: "2026-09-11",
      in: "08:00",
      out: "17:00",
      break: "01:00",
      leave: "00:00",
      leaveType: "",
      duplicate: "✓",
    });
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1D4ED8" },
    };
    for (let row = 2; row <= 1000; row++) {
      ws.getCell(`A${row}`).dataValidation = {
        type: "list",
        allowBlank: false,
        formulae: [`"${employees.map((item) => item.personnel_code).join(",")}"`],
        showErrorMessage: true,
        errorTitle: "کد پرسنلی نامعتبر",
        error: "کد پرسنلی را از فهرست انتخاب کنید",
      };
      ws.getCell(`B${row}`).dataValidation = {
        type: "date",
        operator: "between",
        formulae: [new Date(2000, 0, 1), new Date(2100, 11, 31)],
        showErrorMessage: true,
        errorTitle: "تاریخ نامعتبر",
        error: "تاریخ معتبر وارد کنید",
      };
      for (const column of ["C", "D", "E", "F"]) {
        ws.getCell(`${column}${row}`).dataValidation = {
          type: "decimal",
          operator: "between",
          formulae: [0, 0.999999],
          allowBlank: true,
          showErrorMessage: true,
          errorTitle: "زمان نامعتبر",
          error: "زمان را با قالب HH:mm وارد کنید",
        };
      }
      ws.getCell(`G${row}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`"${leaveTypes.map((item) => item.name).join(",")}"`],
        showErrorMessage: true,
        errorTitle: "نوع مرخصی نامعتبر",
        error: "یکی از انواع مرخصی تعریف‌شده را انتخاب کنید",
      };
      ws.getCell(`H${row}`).value = {
        formula: `IF(COUNTIFS($A$2:$A${row},A${row},$B$2:$B${row},B${row})=1,"✓","تکراری")`,
      };
    }
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=kara-attendance-template.xlsx",
    );
    res.send(Buffer.from(buffer));
  }),
);

app.post(
  "/api/import/attendance",
  upload.single("file"),
  handler(async (req, res) => {
    if (!req.file)
      return res.status(400).json({ error: "فایل ارسال نشده است" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ExcelJS.Buffer);
    const ws = wb.worksheets[0];
    const headers = new Map<string, number>();
    ws.getRow(1).eachCell((cell, col) =>
      headers.set(String(cell.value).trim(), col),
    );
    const col = (...names: string[]) =>
      names.map((n) => headers.get(n)).find(Boolean);
    const rows: {
      row: number;
      personnelCode: string;
      workDate: string;
      checkInMinute: number | null;
      checkOutMinute: number | null;
      breakMinutes: number;
      leaveMinutes: number;
      leaveTypeName: string;
    }[] = [];
    const errors: { row: number; message: string }[] = [];
    const duplicateKeys = new Set<string>();
    const isValidMinute = (value: unknown) => {
      if (value == null || value === "") return true;
      if (typeof value === "number") return value >= 0 && value < 1440;
      const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
      return !!match && Number(match[1]) < 24 && Number(match[2]) < 60;
    };
    for (let n = 2; n <= ws.rowCount; n++) {
      const r = ws.getRow(n);
      const code = String(
        r.getCell(col("کد پرسنلی", "personnelCode") ?? 1).value ?? "",
      ).trim();
      const date = iso(r.getCell(col("تاریخ", "workDate") ?? 2).value);
      if (!code && !date) continue;
      const checkIn = parseMinute(r.getCell(col("ورود", "checkIn") ?? 3).value),
        checkOut = parseMinute(r.getCell(col("خروج", "checkOut") ?? 4).value);
      const leaveTypeName = String(
        r.getCell(col("نوع مرخصی", "leaveType") ?? 7).value ?? "",
      ).trim();
      if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        errors.push({ row: n, message: "کد پرسنلی یا تاریخ معتبر نیست" });
      else if (!isValidMinute(r.getCell(col("ورود", "checkIn") ?? 3).value) || !isValidMinute(r.getCell(col("خروج", "checkOut") ?? 4).value) || !isValidMinute(r.getCell(col("استراحت", "breakMinutes") ?? 5).value) || !isValidMinute(r.getCell(col("مرخصی", "leaveMinutes") ?? 6).value))
        errors.push({ row: n, message: "زمان واردشده معتبر نیست" });
      else if ((checkIn == null) !== (checkOut == null))
        errors.push({ row: n, message: "ورود و خروج باید با هم ثبت شوند" });
      else if (checkIn != null && checkOut != null) {
        const elapsed = checkOut >= checkIn ? checkOut - checkIn : checkOut + 1440 - checkIn;
        const breakMinutes = parseMinute(r.getCell(col("استراحت", "breakMinutes") ?? 5).value) ?? 0;
        if (breakMinutes > elapsed)
          errors.push({ row: n, message: "استراحت نمی‌تواند بیشتر از حضور باشد" });
        else {
          const key = `${code}::${date}`;
          if (duplicateKeys.has(key)) errors.push({ row: n, message: "ردیف تکراری در فایل" });
          else {
            duplicateKeys.add(key);
            rows.push({ row: n, personnelCode: code, workDate: date, checkInMinute: checkIn, checkOutMinute: checkOut, breakMinutes, leaveMinutes: parseMinute(r.getCell(col("مرخصی", "leaveMinutes") ?? 6).value) ?? 0, leaveTypeName });
          }
        }
      } else {
        const key = `${code}::${date}`;
        if (duplicateKeys.has(key)) errors.push({ row: n, message: "ردیف تکراری در فایل" });
        else {
          duplicateKeys.add(key);
          rows.push({
            row: n,
            personnelCode: code,
            workDate: date,
            checkInMinute: checkIn,
            checkOutMinute: checkOut,
            breakMinutes: parseMinute(r.getCell(col("استراحت", "breakMinutes") ?? 5).value) ?? 0,
            leaveMinutes: parseMinute(r.getCell(col("مرخصی", "leaveMinutes") ?? 6).value) ?? 0,
            leaveTypeName,
          });
        }
      }
    }
    // Preview is deliberately validated against PostgreSQL as well: a green
    // preview must be safe to commit as one all-or-nothing transaction.
    if (rows.length) {
      const codes = [...new Set(rows.map((row) => row.personnelCode))];
      const leaveNames = [...new Set(rows.map((row) => row.leaveTypeName).filter(Boolean))];
      const known = new Set(
        (
          await pool.query<{ personnel_code: string }>(
            "SELECT personnel_code FROM employees WHERE personnel_code = ANY($1)",
            [codes],
          )
        ).rows.map((employee) => employee.personnel_code),
      );
      for (const row of rows)
        if (!known.has(row.personnelCode))
          errors.push({ row: row.row, message: `کد پرسنلی ${row.personnelCode} یافت نشد` });
      const knownLeaves = new Set(
        leaveNames.length
          ? (await pool.query<{ name: string }>("SELECT name FROM leave_types WHERE name = ANY($1)", [leaveNames])).rows.map((item) => item.name)
          : [],
      );
      for (const row of rows) {
        if (row.leaveMinutes > 0 && !row.leaveTypeName)
          errors.push({ row: row.row, message: "برای ساعت مرخصی، نوع مرخصی الزامی است" });
        else if (row.leaveTypeName && !knownLeaves.has(row.leaveTypeName))
          errors.push({ row: row.row, message: `نوع مرخصی «${row.leaveTypeName}» یافت نشد` });
      }
    }
    if (req.query.mode !== "commit" || errors.length)
      return res.json({
        valid: errors.length === 0,
        totalRows: rows.length + errors.length,
        rows,
        errors,
      });
    const batchId = randomUUID();
    await transaction(
      auditContext(req, "ورود گروهی حضور", batchId),
      async (c) => {
        await c.query(
          "INSERT INTO import_batches(id,file_name,status,total_rows,accepted_rows,rejected_rows,errors) VALUES($1,$2,'completed',$3,$3,0,'[]')",
          [batchId, req.file!.originalname, rows.length],
        );
        for (const row of rows) {
          const employee = (
            await c.query("SELECT id FROM employees WHERE personnel_code=$1", [
              row.personnelCode,
            ])
          ).rows[0];
          if (!employee)
            throw new Error(`کد پرسنلی ${row.personnelCode} یافت نشد`);
          const leaveType = row.leaveTypeName
            ? (await c.query("SELECT id FROM leave_types WHERE name=$1", [row.leaveTypeName])).rows[0]
            : null;
          const { schedule, holiday } = await resolveWorkDay(
            c,
            employee.id,
            row.workDate,
          );
          const calc = calculateAttendance({
            checkInMinute: row.checkInMinute,
            checkOutMinute: row.checkOutMinute,
            breakMinutes: row.breakMinutes,
            leaveMinutes: row.leaveMinutes,
            scheduleStart: schedule.start_minute,
            scheduleEnd: schedule.end_minute,
            holiday,
          });
          await c.query(
            `INSERT INTO attendance_entries(employee_id,work_date,check_in_minute,check_out_minute,break_minutes,leave_type_id,leave_minutes,actual_minutes,required_minutes,delay_minutes,early_leave_minutes,deficit_minutes,overtime_minutes,computed_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(employee_id,work_date) DO UPDATE SET check_in_minute=EXCLUDED.check_in_minute,check_out_minute=EXCLUDED.check_out_minute,break_minutes=EXCLUDED.break_minutes,leave_type_id=EXCLUDED.leave_type_id,leave_minutes=EXCLUDED.leave_minutes,actual_minutes=EXCLUDED.actual_minutes,required_minutes=EXCLUDED.required_minutes,delay_minutes=EXCLUDED.delay_minutes,early_leave_minutes=EXCLUDED.early_leave_minutes,deficit_minutes=EXCLUDED.deficit_minutes,overtime_minutes=EXCLUDED.overtime_minutes,computed_status=EXCLUDED.computed_status,updated_at=now()`,
            [
              employee.id,
              row.workDate,
              row.checkInMinute,
              row.checkOutMinute,
              row.breakMinutes,
              leaveType?.id ?? null,
              row.leaveMinutes,
              calc.actualMinutes,
              calc.requiredMinutes,
              calc.delayMinutes,
              calc.earlyLeaveMinutes,
              calc.deficitMinutes,
              calc.overtimeMinutes,
              calc.status,
            ],
          );
        }
      },
    );
    res.json({ valid: true, batchId, imported: rows.length });
  }),
);

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    void _next;
    const e = error as { message?: string; status?: number; issues?: unknown };
    console.error(e);
    res.status(e.status ?? (e instanceof z.ZodError ? 400 : 500)).json({
      error:
        e instanceof z.ZodError
          ? "اطلاعات ورودی معتبر نیست"
          : (e.message ?? "خطای داخلی"),
      details: e instanceof z.ZodError ? e.issues : undefined,
    });
  },
);

const port = Number(process.env.API_PORT ?? 3001);
migrate()
  .then(async () => {
    const employeeCount = Number(
      (await pool.query("SELECT COUNT(*) FROM employees")).rows[0].count,
    );
    if (employeeCount === 0)
      await transaction({ reason: "داده اولیه" }, async (c) => {
        await c.query(
          `INSERT INTO employees(personnel_code,full_name,start_date,base_salary) VALUES ('EMP-1001','نیما احمدی','2024-01-01',450000000),('EMP-1002','سارا کریمی','2024-03-10',520000000),('EMP-1003','علی رضایی','2025-01-05',390000000),('EMP-1004','مریم قاسمی','2023-08-15',610000000)`,
        );
      });
    const formulaCount = Number(
      (await pool.query("SELECT COUNT(*) FROM formula_components")).rows[0]
        .count,
    );
    if (formulaCount === 0)
      await transaction({ reason: "فرمول‌های اولیه" }, async (c) => {
        const defaults: FormulaDefinition[] = [
          {
            code: "base_pay",
            name: "حقوق پایه",
            kind: "earning",
            expression: { type: "variable", name: "base_salary" },
          },
          {
            code: "overtime_pay",
            name: "فوق‌العاده اضافه‌کاری",
            kind: "earning",
            expression: {
              type: "binary",
              operator: "*",
              left: { type: "variable", name: "overtime_minutes" },
              right: {
                type: "binary",
                operator: "/",
                left: { type: "variable", name: "base_salary" },
                right: { type: "number", value: 13200 },
              },
            },
          },
          {
            code: "deficit_deduction",
            name: "کسر کار",
            kind: "deduction",
            expression: {
              type: "binary",
              operator: "*",
              left: { type: "variable", name: "deficit_minutes" },
              right: {
                type: "binary",
                operator: "/",
                left: { type: "variable", name: "base_salary" },
                right: { type: "number", value: 13200 },
              },
            },
          },
        ];
        for (const d of defaults) {
          const component = (
            await c.query(
              "INSERT INTO formula_components(code,name,kind) VALUES($1,$2,$3) RETURNING id",
              [d.code, d.name, d.kind],
            )
          ).rows[0];
          const version = (
            await c.query(
              "INSERT INTO formula_versions(component_id,version,expression,expression_text) VALUES($1,1,$2,$3) RETURNING id",
              [component.id, d.expression, expressionText(d.expression)],
            )
          ).rows[0];
          await c.query(
            "UPDATE formula_components SET active_version_id=$1 WHERE id=$2",
            [version.id, component.id],
          );
        }
      });
    app.listen(port, () =>
      console.log(`Kara API ready at http://localhost:${port}`),
    );
  })
  .catch((error) => {
    console.error("PostgreSQL is not ready:", error);
    process.exitCode = 1;
  });
