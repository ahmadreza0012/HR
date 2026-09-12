"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Employee = {
  id: string;
  personnelCode: string;
  fullName: string;
  employmentStatus: string;
  startDate: string;
  endDate?: string | null;
  baseSalary: number;
  duties?: string;
  customValues: Record<string, number>;
  customValueKinds?: Record<string, "earning" | "deduction">;
};
type Attendance = {
  id: string;
  employee_id: string;
  fullName: string;
  personnelCode: string;
  work_date: string;
  check_in_minute: number | null;
  check_out_minute: number | null;
  break_minutes: number;
  leave_type_id: string | null;
  leave_minutes: number;
  notes: string | null;
  actual_minutes: number;
  required_minutes: number;
  deficit_minutes: number;
  overtime_minutes: number;
  computed_status: string;
  override_status: string | null;
};
type Monthly = {
  id: string;
  fullName: string;
  personnelCode: string;
  requiredDays: number;
  scheduledMinutes: number;
  recordedDays: number;
  presentDays: number;
  absentDays: number;
  leaveDays: number;
  actualMinutes: number;
  requiredMinutes: number;
  leaveMinutes: number;
  paidLeaveMinutes?: number;
  unpaidLeaveMinutes?: number;
  deficitMinutes: number;
  overtimeMinutes: number;
};
type Formula = {
  id: string;
  code: string;
  name: string;
  kind: "earning" | "deduction" | "net";
  version: number;
  expressionText: string;
  expression: unknown;
};
type Audit = {
  id: string | number;
  occurredAt: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  reason: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  sessionId: string;
  batchId: string | null;
};
type Period = {
  id: string;
  year: number;
  month: number;
  status: "draft" | "processing" | "locked";
  lockedAt: string | null;
  resultCount: number;
  earnings: number;
  deductions: number;
  netPay: number;
};
type Payslip = {
  id: string;
  periodId: string;
  year: number;
  month: number;
  status: string;
  fullName: string;
  personnelCode: string;
  inputs: Record<string, number>;
  componentResults: { code: string; name: string; kind: string; value: number; expression: string }[];
  earnings: number;
  deductions: number;
  netPay: number;
  calculatedAt: string;
};
type Config = {
  schedules: {
    id: string;
    name: string;
    startMinute: number;
    endMinute: number;
    breakMinutes: number;
    workDays: number[];
    isDefault: boolean;
  }[];
  leaveTypes: { id: string; name: string; unit: string; isPaid: boolean }[];
  holidays: { id: string; date: string; title: string }[];
  overrides: {
    date: string;
    scheduleId: string | null;
    isHoliday: boolean;
    scheduleName: string | null;
  }[];
};
type Settings = {
  currency: "IRR" | "IRT" | "USD" | "EUR";
  roundingMode: "nearest" | "up" | "down";
  globalValues: Record<string, number>;
};

// In production the API is hosted separately from the Vercel frontend.
// Keep the local API as the development fallback.
const API = (import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? "/api" : "http://localhost:3001/api")).replace(/\/$/, "");
const isSheetsApi = API.includes("script.google.com/macros/s/");
const API_CACHE_PREFIX = "kara-payroll-api-cache:";
const API_CACHE_TTL = 60_000;
// Google Apps Script has cold starts and can take longer than a local API.
// Do not cancel a valid Sheets request at the previous 15-second threshold.
const API_TIMEOUT_MS = 45_000;
const apiUrl = (path: string) => {
  if (!isSheetsApi) return `${API}${path}`;
  const [pathname, search] = path.replace(/^\//, "").split("?", 2);
  const params = new URLSearchParams(search ?? "");
  params.set("path", pathname);
  return `${API}?${params.toString()}`;
};
const normalizeAudit = (value: any): Audit => ({
  id: value.id ?? crypto.randomUUID(),
  occurredAt: value.occurredAt ?? value.createdAt ?? new Date(0).toISOString(),
  actorId: value.actorId ?? "system",
  action: value.action ?? value.operation ?? "UNKNOWN",
  entityType: value.entityType ?? value.tableName ?? "system",
  entityId: value.entityId ?? value.rowId ?? "",
  reason: value.reason ?? null,
  beforeValue: value.beforeValue ?? value.beforeData ?? null,
  afterValue: value.afterValue ?? value.afterData ?? null,
  sessionId: value.sessionId ?? "",
  batchId: value.batchId ?? null,
});
type Language = "fa" | "en";
const readApiCache = <T,>(path: string): T | undefined => {
  try {
    const raw = window.localStorage.getItem(`${API_CACHE_PREFIX}${API}${path}`);
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as { expiresAt: number; value: T };
    if (cached.expiresAt > Date.now()) return cached.value;
    window.localStorage.removeItem(`${API_CACHE_PREFIX}${API}${path}`);
  } catch { /* Cache is optional. */ }
  return undefined;
};
const writeApiCache = <T,>(path: string, value: T) => {
  try {
    window.localStorage.setItem(
      `${API_CACHE_PREFIX}${API}${path}`,
      JSON.stringify({ expiresAt: Date.now() + API_CACHE_TTL, value }),
    );
  } catch { /* Storage can be unavailable or full. */ }
};
const clearApiCache = () => {
  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith(API_CACHE_PREFIX))
      .forEach((key) => window.localStorage.removeItem(key));
  } catch { /* Cache is optional. */ }
};
const nav = [
  ["dashboard", "⌂", "داشبورد"],
  ["employees", "♙", "کارمندان"],
  ["attendance", "◷", "حضور و غیاب"],
  ["calendar", "▦", "تقویم و شیفت‌ها"],
  ["rules", "◈", "شیفت و مرخصی"],
  ["payroll", "◫", "پردازش حقوق"],
  ["payslips", "▤", "فیش حقوق"],
  ["formula", "ƒ", "فرمول‌ها"],
  ["reports", "↗", "گزارش‌ها و اکسل"],
  ["audit", "◉", "تاریخچه تغییرات"],
  ["settings", "⚙", "تنظیمات"],
] as const;
type TabKey = (typeof nav)[number][0];
const navEnglish: Record<TabKey, string> = {
  dashboard: "Dashboard", employees: "Employees", attendance: "Attendance",
  calendar: "Calendar & Shifts", rules: "Shifts & Leave", payroll: "Payroll",
  payslips: "Payslips", formula: "Formulas", reports: "Reports", audit: "Audit log", settings: "Settings",
};
const navLabel = (key: TabKey, language: Language) =>
  language === "en" ? navEnglish[key] : nav.find((item) => item[0] === key)?.[2] ?? key;
const englishUi: Record<string, string> = {
  "سامانه محلی": "Local workspace",
  "صبح بخیر، مدیر 👋": "Good morning, Administrator",
  "اطلاعات این بخش در Google Sheets ذخیره می‌شود": "Changes in this section are stored in Google Sheets",
  "Google Sheets متصل": "Google Sheets connected",
  "Google Sheets قطع": "Google Sheets offline",
  "ثبت حضور روزانه": "Add attendance",
  "در حال دریافت اطلاعات...": "Loading data…",
  "در حال ذخیره‌سازی...": "Saving…",
  "تعطیلات هفتگی": "Weekly days off",
  "ذخیره روزهای تعطیل": "Save days off",
  "تقویم کاری": "Work calendar",
  "برنامه‌های کاری": "Work schedules",
  "انتخاب روز برای تعیین تعطیلی یا شیفت کاری": "Select a date to set a holiday or work schedule",
  "شیفت، روزهای کاری و استراحت": "Shifts, workdays and breaks",
  "شیفت جدید": "New shift",
  "شیفت عادی": "Standard shift",
  "شیفت استاندارد انتاریو": "Ontario standard shift",
  "شیفت بدون عنوان": "Untitled shift",
  "نام شیفت": "Shift name",
  "شروع": "Start",
  "پایان": "End",
  "استراحت": "Break",
  "دقیقه استراحت": "minutes break",
  "ذخیره": "Save",
  "ویرایش": "Edit",
  "حذف": "Delete",
  "پیش‌فرض": "Default",
  "روز کاری": "Work day",
  "تعطیلی ثبت‌شده": "Recorded holiday",
  "تعطیل هفتگی": "Weekend",
  "تنظیم روز تقویم": "Calendar day settings",
  "ماه قبل": "Previous month",
  "ماه بعد": "Next month",
  "کارمند": "Employee",
  "همه کارکنان": "All employees",
  "وضعیت روز": "Day status",
  "تعطیل": "Holiday",
  "شیفت کاری": "Work shift",
  "دلیل": "Reason",
  "انصراف": "Cancel",
  "حضور و غیاب روزانه": "Daily attendance",
  "ثبت حضور": "Add attendance",
  "تاریخ": "Date",
  "ورود": "Clock in",
  "خروج": "Clock out",
  "نوع مرخصی": "Leave type",
  "بدون مرخصی": "No leave",
  "توضیحات": "Notes",
  "محاسبه و ذخیره": "Calculate and save",
  "کارمندان فعال": "Active employees",
  "فرآیند حقوق": "Payroll status",
  "بدون داده": "No data",
  "آماده محاسبه": "Ready to calculate",
  "مشاهده همه ←": "View all →",
  "پردازش حقوق ماهانه": "Monthly payroll processing",
  "محاسبه حقوق": "Calculate payroll",
  "فیش‌های حقوق": "Payslips",
  "گزارش‌ها و اکسل": "Reports & Excel",
  "تاریخچه تغییرات": "Change history",
  "تنظیمات": "Settings",
  "دسترسی کامل": "Full access",
  "پایگاه‌داده قطع است": "Data connection is unavailable",
};
const translateUiText = (value: string, language: Language) => {
  if (language === "fa") return value;
  return Object.entries(englishUi).reduce(
    (translated, [persian, english]) => translated.replaceAll(persian, english),
    value,
  );
};
const originalUiText = new WeakMap<Text, string>();
const tabRoutes: Record<TabKey, string> = {
  dashboard: "/",
  employees: "/employees",
  attendance: "/attendance",
  calendar: "/calendar",
  rules: "/shifts-leaves",
  payroll: "/payroll",
  payslips: "/payslips",
  formula: "/formulas",
  reports: "/reports",
  audit: "/audit-log",
  settings: "/settings",
};
const defaultEmployeeDuties = (employee: Employee & Record<string, unknown>) => {
  const role = String(employee.jobCode ?? "").toLowerCase();
  if (role.includes("warehouse")) return "دریافت، چیدمان و کنترل موجودی کالا؛ ثبت مغایرت‌ها و رعایت ایمنی انبار.";
  if (role.includes("team lead")) return "هماهنگی تیم عملیاتی، پیگیری برنامه روزانه، کنترل کیفیت و گزارش‌دهی به مدیر.";
  if (role.includes("payroll")) return "ثبت و کنترل داده‌های حضور و غیاب، تهیه گزارش حقوق و حفظ محرمانگی اطلاعات کارکنان.";
  if (role.includes("support")) return "پاسخ‌گویی به درخواست‌های پشتیبانی، ثبت و پیگیری تیکت‌ها و مستندسازی راهکارها.";
  if (role.includes("account")) return "پیگیری مشتریان، به‌روزرسانی اطلاعات فروش و هماهنگی امور اجرایی حساب‌ها.";
  if (role.includes("manager")) return "برنامه‌ریزی عملیات، نظارت بر عملکرد تیم، مدیریت منابع و ارائه گزارش مدیریتی.";
  return `انجام وظایف محوله در واحد ${String(employee.department ?? "مربوطه")}، همکاری با تیم و ثبت گزارش کار.`;
};
const scheduleTitleFa = (name: unknown) => {
  const value = String(name ?? "").trim();
  if (value === "Color") return "شیفت عادی";
  if (value.startsWith("Ontario demo standard")) return "شیفت استاندارد انتاریو";
  return value || "شیفت بدون عنوان";
};
const leaveTitleFa = (leave: { name?: unknown; isPaid?: boolean }) => {
  const value = String(leave.name ?? "").trim();
  if (!value || /^\d+$/.test(value)) return leave.isPaid ? "مرخصی استحقاقی" : "مرخصی بدون حقوق";
  if (value.toLowerCase() === "annual leave") return "مرخصی استحقاقی";
  if (value.toLowerCase() === "sick leave") return "مرخصی استعلاجی";
  if (value.toLowerCase() === "unpaid leave") return "مرخصی بدون حقوق";
  return value;
};
const holidayTitleFa = (title: unknown) => ({
  "Good Friday": "جمعه نیک",
  "Victoria Day": "روز ویکتوریا",
  "Canada Day": "روز کانادا",
  "Labour Day": "روز کارگر",
  "Family Day": "روز خانواده",
  "Thanksgiving Day": "روز شکرگزاری",
  "New Year's Day": "روز سال نو",
  "Christmas Day": "روز کریسمس",
  "Boxing Day": "روز باکسینگ",
}[String(title ?? "").trim()] ?? String(title ?? "تعطیلی"));
const tabForPath = (path: string): TabKey =>
  ((Object.entries(tabRoutes) as [TabKey, string][]).find(([, route]) => route === path)?.[0] ?? "dashboard");
const statusFa: Record<string, string> = {
  present: "حاضر",
  absent: "غایب",
  leave: "مرخصی",
  holiday: "تعطیل",
  incomplete: "ناقص",
  active: "فعال",
  inactive: "غیرفعال",
};
const entityFa: Record<string, string> = {
  employees: "کارمند",
  attendance_entries: "حضور روزانه",
  formula_components: "مولفه حقوق",
  formula_versions: "نسخه فرمول",
  work_schedules: "شیفت",
  leave_types: "نوع مرخصی",
  payroll_periods: "دوره حقوق",
  payroll_results: "نتیجه حقوق",
  import_batches: "ورود Excel",
};
const actionFa: Record<string, string> = {
  INSERT: "ایجاد",
  UPDATE: "ویرایش",
  DELETE: "حذف",
};
const money = (n: number) =>
  new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 }).format(n || 0);
const parseJsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
};
const normalizePayslip = (raw: any): Payslip => {
  const trace = parseJsonValue(raw.componentResults ?? raw.component_results ?? raw.formulaSnapshot ?? raw.formula_snapshot);
  return {
    ...raw,
    id: String(raw.id ?? ""),
    periodId: String(raw.periodId ?? raw.period_id ?? ""),
    year: Number(raw.year ?? 0),
    month: Number(raw.month ?? 0),
    status: String(raw.status ?? raw.payrollStatus ?? raw.payroll_status ?? ""),
    fullName: String(raw.fullName ?? raw.full_name ?? "کارمند"),
    personnelCode: String(raw.personnelCode ?? raw.personnel_code ?? ""),
    inputs: (parseJsonValue(raw.inputs) as Record<string, number>) ?? {},
    componentResults: Array.isArray(trace)
      ? trace
      : Array.isArray((trace as any)?.trace) ? (trace as any).trace : [],
    earnings: Number(raw.earnings ?? 0),
    deductions: Number(raw.deductions ?? 0),
    netPay: Number(raw.netPay ?? raw.net ?? raw.net_pay ?? 0),
    calculatedAt: String(raw.calculatedAt ?? raw.calculated_at ?? ""),
  };
};
const min = (n: number | null | undefined) =>
  n == null
    ? "—"
    : `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const toMin = (v: string) => {
  if (!v) return null;
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
};
const today = new Date().toISOString().slice(0, 10);
const now = new Date();
const weekDaysCanada = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const isoDate = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
const addDays = (date: Date, amount: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
};
const easterSunday = (year: number) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
};
const nthWeekday = (year: number, month: number, weekday: number, nth: number) => {
  const first = new Date(year, month, 1);
  return new Date(year, month, 1 + ((weekday - first.getDay() + 7) % 7) + 7 * (nth - 1));
};
const ontarioPublicHolidays = (year: number) => {
  const victoriaDay = new Date(year, 4, 24);
  while (victoriaDay.getDay() !== 1) victoriaDay.setDate(victoriaDay.getDate() - 1);
  const easter = easterSunday(year);
  return [
    { date: isoDate(new Date(year, 0, 1)), title: "New Year's Day" },
    { date: isoDate(nthWeekday(year, 1, 1, 3)), title: "Family Day" },
    { date: isoDate(addDays(easter, -2)), title: "Good Friday" },
    { date: isoDate(victoriaDay), title: "Victoria Day" },
    { date: isoDate(new Date(year, 6, 1)), title: "Canada Day" },
    { date: isoDate(nthWeekday(year, 8, 1, 1)), title: "Labour Day" },
    { date: isoDate(nthWeekday(year, 9, 1, 2)), title: "Thanksgiving Day" },
    { date: isoDate(new Date(year, 11, 25)), title: "Christmas Day" },
    { date: isoDate(new Date(year, 11, 26)), title: "Boxing Day" },
  ].map((event) => ({ ...event, id: `ontario-${event.date}` }));
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const sheetsRequest = isSheetsApi && options?.body != null;
  const method = String(options?.method ?? "GET").toUpperCase();
  const canUseCache = method === "GET";
  if (canUseCache) {
    const cached = readApiCache<T>(path);
    if (cached !== undefined) return cached;
  } else {
    // A successful write must never be followed by a stale read after refresh.
    clearApiCache();
  }
  const sheetsUrl = sheetsRequest && method !== "POST"
    ? `${apiUrl(path)}&method=${encodeURIComponent(method)}`
    : apiUrl(path);
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(sheetsUrl, {
      ...options,
      method: sheetsRequest ? "POST" : options?.method,
      signal: timeout.signal,
      headers: {
        ...(sheetsRequest ? { "Content-Type": "text/plain;charset=utf-8" } : { "Content-Type": "application/json", "x-session-id": "kara-local" }),
        ...(options?.headers ?? {}),
      },
      body: sheetsRequest && typeof options?.body === "string" ? options.body : options?.body,
    });
  } finally {
    window.clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "ارتباط با سرور ناموفق بود");
  }
  const value = res.status === 204 ? (undefined as T) : await res.json() as T;
  if (canUseCache) writeApiCache(path, value);
  return value;
}

export function PayrollApp({ initialTab = "dashboard" }: { initialTab?: TabKey }) {
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [language, setLanguage] = useState<Language>(() =>
    typeof window !== "undefined" && window.localStorage.getItem("kara-language") === "en" ? "en" : "fa",
  );
  const [mobileMenu, setMobileMenu] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [monthly, setMonthly] = useState<Monthly[]>([]);
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [config, setConfig] = useState<Config>({
    schedules: [],
    leaveTypes: [],
    holidays: [],
    overrides: [],
  });
  const [settings, setSettings] = useState<Settings>({
    currency: "IRR",
    roundingMode: "nearest",
    globalValues: {},
  });
  const [selectedDate, setSelectedDate] = useState(today);
  const [online, setOnline] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(""), 3200);
  };
  const load = useCallback(async () => {
    setLoading(true);
    const jobs: Promise<unknown>[] = [];
    const add = <T,>(job: Promise<T>, apply: (value: T) => void) =>
      jobs.push(job.then(apply));
    const monthQuery = `year=${now.getFullYear()}&month=${now.getMonth() + 1}`;

    if (["dashboard", "employees", "attendance", "calendar", "rules", "formula", "reports"].includes(tab))
      add(request<Employee[]>("/employees").then((records) => records.map((employee) => ({ ...employee, duties: employee.duties?.trim() || defaultEmployeeDuties(employee) }))), setEmployees);
    if (["dashboard", "attendance"].includes(tab))
      add(request<Attendance[]>(`/attendance?date=${selectedDate}`), setAttendance);
    if (["dashboard", "payroll"].includes(tab))
      add(request<Monthly[]>(`/monthly?${monthQuery}`), setMonthly);
    if (["payroll", "formula"].includes(tab))
      add(request<Formula[]>("/formulas"), setFormulas);
    if (tab === "payroll")
      add(request<Period[]>("/payroll/periods"), setPeriods);
    if (["attendance", "calendar", "rules"].includes(tab))
      add(request<Config>("/schedules"), setConfig);
    if (["dashboard", "audit"].includes(tab))
      add(request<any[]>("/audit").then((items) => items.map(normalizeAudit)), setAudits);
    if (tab === "settings")
      add(request<Settings>("/settings"), setSettings);
    if (tab === "payslips")
      add(request<any[]>(`/payroll/results?${monthQuery}`).then((items) => items.map(normalizePayslip)), setPayslips);

    const results = await Promise.allSettled(jobs);
    setOnline(results.some((result) => result.status === "fulfilled"));
    setLoading(false);
  }, [selectedDate, tab]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useEffect(() => {
    // Rewrites serve deep links through the root page, so restore the selected
    // section from the browser URL after hydration.
    setTab(tabForPath(window.location.pathname));
    const onPopState = () => {
      setTab(tabForPath(window.location.pathname));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    window.localStorage.setItem("kara-language", language);
    document.documentElement.lang = language === "en" ? "en-CA" : "fa";
    document.documentElement.dir = language === "en" ? "ltr" : "rtl";
    const updateText = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const original = originalUiText.get(node) ?? node.data;
        if (!original.trim()) continue;
        originalUiText.set(node, original);
        const translated = translateUiText(original, language);
        if (node.data !== translated) node.data = translated;
      }
    };
    const observer = new MutationObserver(updateText);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    updateText();
    return () => observer.disconnect();
  }, [language]);
  const run = async (task: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await task();
      await load();
      notify(message);
    } catch (e) {
      notify(e instanceof Error ? e.message : "عملیات ناموفق بود");
    } finally {
      setBusy(false);
    }
  };
  const active = employees.filter(
    (e) => e.employmentStatus === "active",
  ).length;
  const sums = useMemo(
    () =>
      monthly.reduce(
        (a, x) => ({ o: a.o + x.overtimeMinutes, d: a.d + x.deficitMinutes }),
        { o: 0, d: 0 },
      ),
    [monthly],
  );
  const selectTab = (nextTab: (typeof nav)[number][0]) => {
    setTab(nextTab);
    setMobileMenu(false);
    if (window.location.pathname !== tabRoutes[nextTab]) window.history.pushState({}, "", tabRoutes[nextTab]);
  };
  return (
    <main className="app-shell" dir={language === "en" ? "ltr" : "rtl"} aria-busy={loading || busy}>
      {(loading || busy) && (
        <div className="api-loading" role="status" aria-live="polite">
          <span className="api-spinner" aria-hidden="true" />
          <span>{busy ? "در حال ذخیره‌سازی..." : "در حال دریافت اطلاعات..."}</span>
        </div>
      )}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">ک</span>
          <div>
            <strong>کارا</strong>
            <small>حقوق و دستمزد</small>
          </div>
        </div>
        <nav aria-label="ناوبری اصلی">
          {nav.map(([key, icon]) => (
            <button
              key={key}
              className={`nav-item ${tab === key ? "active" : ""}`}
              onClick={() => selectTab(key)}
            >
              <span>{icon}</span>
              {navLabel(key, language)}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="avatar">م</span>
          <div>
            <strong>مدیر سیستم</strong>
            <small>
              {online === false ? "پایگاه‌داده قطع است" : "دسترسی کامل"}
            </small>
          </div>
          <span className={`db-dot ${online ? "ok" : ""}`} />
        </div>
      </aside>
      <section className="workspace">
        <Header
          tab={tab}
          onPrimary={() =>
            selectTab(tab === "employees" ? "employees" : "attendance")
          }
          online={online}
          language={language}
          onLanguageChange={() => setLanguage((current) => current === "fa" ? "en" : "fa")}
        />
        {tab === "dashboard" && (
          <Dashboard
            active={active}
            employees={employees}
            attendance={attendance}
            monthly={monthly}
            overtime={sums.o}
            audits={audits}
            go={selectTab}
          />
        )}
        {tab === "employees" && (
          <EmployeesPage items={employees} busy={busy} run={run} />
        )}
        {tab === "attendance" && (
          <AttendancePage
            items={attendance}
            employees={employees}
            config={config}
            date={selectedDate}
            setDate={setSelectedDate}
            busy={busy}
            run={run}
          />
        )}
        {tab === "calendar" && (
          <CalendarPage config={config} employees={employees} busy={busy} run={run} view="calendar" />
        )}
        {tab === "rules" && (
          <CalendarPage config={config} employees={employees} busy={busy} run={run} view="rules" />
        )}
        {tab === "payroll" && (
          <PayrollPage
            monthly={monthly}
            formulas={formulas}
            periods={periods}
            busy={busy}
            run={run}
          />
        )}
        {tab === "payslips" && <PayslipsPage items={payslips} />}
        {tab === "formula" && (
          <FormulaPage items={formulas} employees={employees} busy={busy} run={run} />
        )}
        {tab === "reports" && <ReportsPage employees={employees} busy={busy} run={run} />}
        {tab === "audit" && <AuditPage items={audits} />}
        {tab === "settings" && (
          <SettingsPage settings={settings} busy={busy} run={run} />
        )}
      </section>
      <nav className="mobile-tabbar" aria-label="ناوبری موبایل">
            {nav.filter(([key]) => ["dashboard", "attendance", "payroll", "formula"].includes(key)).map(([key, icon]) => (
              <button key={key} className={tab === key ? "active" : ""} onClick={() => selectTab(key)}>
            <span>{icon}</span><small>{navLabel(key, language)}</small>
          </button>
        ))}
        <button className={mobileMenu ? "active" : ""} onClick={() => setMobileMenu((current) => !current)} aria-expanded={mobileMenu} aria-controls="mobile-more-menu">
          <span>•••</span><small>بیشتر</small>
        </button>
      </nav>
      {mobileMenu && <div className="mobile-menu-backdrop">
        <button type="button" className="mobile-menu-dismiss" aria-label="بستن فهرست بیشتر" onClick={() => setMobileMenu(false)} />
        <section className="mobile-menu-sheet" id="mobile-more-menu" aria-label="بخش‌های بیشتر">
          <div className="mobile-sheet-handle" />
          <div className="mobile-sheet-head"><div><strong>بخش‌های بیشتر</strong><small>دسترسی سریع به همه امکانات</small></div><button aria-label="بستن" onClick={() => setMobileMenu(false)}>×</button></div>
          <div className="mobile-sheet-grid">
            {nav.filter(([key]) => !["dashboard", "attendance", "payroll", "formula"].includes(key)).map(([key, icon]) => (
              <button key={key} className={tab === key ? "active" : ""} onClick={() => selectTab(key)}><span>{icon}</span><small>{navLabel(key, language)}</small></button>
            ))}
          </div>
        </section>
      </div>}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </main>
  );
}

function Header({
  tab,
  onPrimary,
  online,
  language,
  onLanguageChange,
}: {
  tab: string;
  onPrimary: () => void;
  online: boolean | null;
  language: Language;
  onLanguageChange: () => void;
}) {
  const title = navLabel(tab as TabKey, language);
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">
          سامانه محلی •{" "}
          {new Intl.DateTimeFormat(language === "en" ? "en-CA" : "fa-IR", { dateStyle: "full" }).format(
            new Date(),
          )}
        </p>
        <h1>{tab === "dashboard" ? language === "en" ? "Good morning, Administrator" : "صبح بخیر، مدیر 👋" : title}</h1>
        <p>
          {tab === "dashboard"
            ? "خلاصه وضعیت نیروی انسانی و پردازش حقوق"
            : "اطلاعات این بخش در Google Sheets ذخیره می‌شود"}
        </p>
      </div>
      <div className="top-actions">
        <button className="secondary-button compact" type="button" onClick={onLanguageChange} aria-label="Change language">
          {language === "fa" ? "English" : "فارسی"}
        </button>
        <span className={`connection ${online ? "connected" : "disconnected"}`}>
          {online ? "● Google Sheets متصل" : "● Google Sheets قطع"}
        </span>
        {(tab === "dashboard" || tab === "attendance") && (
          <button className="primary-button" onClick={onPrimary}>
            ＋ ثبت حضور روزانه
          </button>
        )}
      </div>
    </header>
  );
}

function Dashboard({
  active,
  employees,
  attendance,
  monthly,
  overtime,
  audits,
  go,
}: {
  active: number;
  employees: Employee[];
  attendance: Attendance[];
  monthly: Monthly[];
  overtime: number;
  audits: Audit[];
  go: (x: TabKey) => void;
}) {
  const present = attendance.filter(
    (x) => (x.override_status ?? x.computed_status) === "present",
  ).length;
  return (
    <>
      <section className="stats-grid">
        <Stat
          label="کارمندان فعال"
          value={String(active)}
          hint="پروفایل‌های فعال"
          tone="blue"
        />
        <Stat
          label="حضور روز انتخابی"
          value={String(present)}
          hint={`${attendance.length} رکورد ثبت‌شده`}
          tone="green"
        />
        <Stat
          label="اضافه‌کاری ماه"
          value={min(overtime)}
          hint="ساعت تجمیع‌شده"
          tone="orange"
        />
        <Stat
          label="فرآیند حقوق"
          value={monthly.length ? "آماده محاسبه" : "بدون داده"}
          hint={`${monthly.length} کارمند`}
          tone="violet"
        />
      </section>
      <section className="content-grid">
        <article className="panel attendance-panel">
          <div className="panel-head">
            <div>
              <h2>آخرین وضعیت حضور</h2>
              <p>داده زنده از Google Sheets</p>
            </div>
            <button className="link-button" onClick={() => go("attendance")}>
              مشاهده همه ←
            </button>
          </div>
          <AttendanceTable rows={attendance.slice(0, 5)} employees={employees} />
        </article>
        <aside className="panel payroll-card">
          <div className="panel-head">
            <div>
              <h2>آمادگی دوره جاری</h2>
              <p>
                {now.getFullYear()} / {now.getMonth() + 1}
              </p>
            </div>
            <span className="badge processing">پیش‌نویس</span>
          </div>
          <div
            className="progress-ring"
            style={{
              background: `conic-gradient(#3977ed 0 ${Math.min(100, monthly.length ? 75 : 12)}%,#eaf0f7 0)`,
            }}
          >
            <div>
              <strong>{monthly.length ? `${monthly.length}` : "۰"}</strong>
              <small>کارمند</small>
            </div>
          </div>
          <dl>
            <div>
              <dt>کسری کار ماه</dt>
              <dd>{min(monthly.reduce((s, x) => s + x.deficitMinutes, 0))}</dd>
            </div>
            <div>
              <dt>نیازمند بررسی</dt>
              <dd className="warning">
                {monthly.filter((x) => x.deficitMinutes > 0).length} مورد
              </dd>
            </div>
            <div>
              <dt>نسخه فرمول</dt>
              <dd>قابل ردیابی</dd>
            </div>
          </dl>
          <button className="secondary-button" onClick={() => go("payroll")}>
            رفتن به پردازش حقوق
          </button>
        </aside>
      </section>
      <section className="activity-strip">
        <div>
          <span className="activity-icon">✓</span>
          <div>
            <strong>همه تغییرات ثبت و قابل پیگیری هستند</strong>
            <p>
              {audits[0]
                ? `آخرین تغییر: ${actionFa[audits[0].action]} ${entityFa[audits[0].entityType] ?? audits[0].entityType}`
                : "هنوز تغییری ثبت نشده است"}
            </p>
          </div>
        </div>
        <button className="link-button" onClick={() => go("audit")}>
          مشاهده تاریخچه
        </button>
      </section>
    </>
  );
}
function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: string;
}) {
  return (
    <article className={`stat-card ${tone}`}>
      <span className="stat-dot" />
      <p>{label}</p>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}

function EmployeesPage({
  items,
  busy,
  run,
}: {
  items: Employee[];
  busy: boolean;
  run: any;
}) {
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [deleting, setDeleting] = useState<Employee | null>(null);
  const customValues = (value: FormDataEntryValue | null) => {
    try {
      const parsed = JSON.parse(String(value ?? "{}").trim() || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
      const output = Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, Number(item)]));
      return Object.values(output).every(Number.isFinite) ? output : null;
    } catch {
      return null;
    }
  };
  const customValueKinds = (value: FormDataEntryValue | null) => {
    try {
      const parsed = JSON.parse(String(value ?? "{}").trim() || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(([, kind]) => kind === "earning" || kind === "deduction"),
      ) as Record<string, "earning" | "deduction">;
    } catch {
      return {};
    }
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const values = customValues(f.get("customValues"));
    if (!values) return;
    run(
      () =>
        request("/employees", {
          method: "POST",
          body: JSON.stringify({
            personnelCode: f.get("code"),
            fullName: f.get("name"),
            employmentStatus: f.get("status"),
            startDate: f.get("start"),
            endDate: f.get("end") || null,
            baseSalary: Number(f.get("salary")),
            duties: String(f.get("duties") ?? "").trim(),
            customValues: values,
            customValueKinds: customValueKinds(f.get("customValuesKinds")),
          }),
        }),
      "کارمند با موفقیت ثبت شد",
    );
    setShow(false);
  };
  const saveEdit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editing) return;
    const data = new FormData(e.currentTarget);
    const values = customValues(data.get("customValues"));
    if (!values) return;
    run(
      () =>
        request(`/employees/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify({
            ...editing,
            personnelCode: data.get("code"),
            fullName: data.get("name"),
            employmentStatus: data.get("status"),
            baseSalary: Number(data.get("salary")),
            duties: String(data.get("duties") ?? "").trim(),
            startDate: data.get("start"),
            endDate: data.get("end") || null,
            customValues: values,
            customValueKinds: customValueKinds(data.get("customValuesKinds")),
          }),
        }),
      "اطلاعات کارمند و Audit Log بروزرسانی شد",
    );
    setEditing(null);
  };
  const remove = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!deleting) return;
    const reason = String(new FormData(e.currentTarget).get("reason") ?? "");
    if (!reason.trim()) return;
    run(
      () =>
        request(`/employees/${deleting.id}`, {
          method: "DELETE",
          body: JSON.stringify({ reason }),
        }),
      "کارمند حذف و سابقه آن ثبت شد",
    );
    setDeleting(null);
  };
  return (
    <PagePanel
      title="کارمندان"
      subtitle={`${items.length} پروفایل ثبت‌شده`}
      action={
        <button className="primary-button" onClick={() => setShow(!show)}>
          ＋ کارمند جدید
        </button>
      }
    >
      {show && (
        <form className="inline-form" onSubmit={submit}>
          <Field label="کد پرسنلی" name="code" required />
          <Field label="نام و نام خانوادگی" name="name" required />
          <label><span>وضعیت استخدام</span><select name="status"><option value="active">فعال</option><option value="inactive">غیرفعال</option></select></label>
          <Field
            label="تاریخ شروع"
            name="start"
            type="date"
            defaultValue={today}
            required
          />
          <Field label="تاریخ پایان (اختیاری)" name="end" type="date" />
          <Field
            label="حقوق پایه"
            name="salary"
            type="number"
            defaultValue="0"
            required
          />
          <label><span>وظایف و شرح مسئولیت‌ها</span><textarea name="duties" rows={3} placeholder="شرح مسئولیت‌های اصلی این کارمند" required /></label>
          <CustomValuesEditor />
          <button disabled={busy} className="primary-button">
            ذخیره
          </button>
        </form>
      )}
      {editing && (
        <form className="inline-form" onSubmit={saveEdit}>
          <Field label="کد پرسنلی" name="code" defaultValue={editing.personnelCode} required />
          <Field
            label="نام و نام خانوادگی"
            name="name"
            defaultValue={editing.fullName}
            required
          />
          <label><span>وضعیت استخدام</span><select name="status" defaultValue={editing.employmentStatus}><option value="active">فعال</option><option value="inactive">غیرفعال</option></select></label>
          <Field label="تاریخ شروع" name="start" type="date" defaultValue={editing.startDate} required />
          <Field label="تاریخ پایان (اختیاری)" name="end" type="date" defaultValue={editing.endDate ?? ""} />
          <Field
            label="حقوق پایه"
            name="salary"
            type="number"
            defaultValue={String(editing.baseSalary)}
            required
          />
          <label><span>وظایف و شرح مسئولیت‌ها</span><textarea name="duties" rows={3} defaultValue={editing.duties ?? defaultEmployeeDuties(editing)} required /></label>
          <CustomValuesEditor initialValues={editing.customValues ?? {}} initialKinds={editing.customValueKinds ?? {}} />
          <button disabled={busy} className="primary-button">
            ذخیره تغییرات
          </button>
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => setEditing(null)}
          >
            انصراف
          </button>
        </form>
      )}
      {deleting && (
        <form className="inline-form danger-form" onSubmit={remove}>
          <p>حذف «{deleting.fullName}» قطعی است؛ دلیل آن را ثبت کنید.</p>
          <Field label="دلیل حذف" name="reason" required />
          <button disabled={busy} className="danger-button">
            ثبت حذف
          </button>
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => setDeleting(null)}
          >
            انصراف
          </button>
        </form>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>کارمند</th>
              <th>وضعیت</th>
              <th>تاریخ شروع</th>
              <th>حقوق پایه</th>
              <th>وظایف</th>
              <th>عملیات</th>
            </tr>
          </thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.id}>
                <td>
                  <div className="person">
                    <span>{x.fullName[0]}</span>
                    <div>
                      <strong>{x.fullName}</strong>
                      <small>{x.personnelCode}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <span className="badge present">
                    {statusFa[x.employmentStatus] ?? x.employmentStatus}
                  </span>
                </td>
                <td>{String(x.startDate).slice(0, 10)}</td>
                <td>{money(x.baseSalary)}</td>
                <td className="duties-cell">{x.duties ?? defaultEmployeeDuties(x)}</td>
                <td>
                  <button className="link-button" onClick={() => setEditing(x)}>
                    ویرایش
                  </button>
                  <button
                    className="danger-link"
                    onClick={() => setDeleting(x)}
                  >
                    حذف
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PagePanel>
  );
}

function AttendancePage({
  items,
  employees,
  config,
  date,
  setDate,
  busy,
  run,
}: {
  items: Attendance[];
  employees: Employee[];
  config: Config;
  date: string;
  setDate: (x: string) => void;
  busy: boolean;
  run: any;
}) {
  const [show, setShow] = useState(false);
  const [override, setOverride] = useState<Attendance | null>(null);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(
      () =>
        request("/attendance", {
          method: "POST",
          body: JSON.stringify({
            employeeId: f.get("employeeId"),
            workDate: f.get("date"),
            checkInMinute: toMin(String(f.get("in"))),
            checkOutMinute: toMin(String(f.get("out"))),
            breakMinutes: Number(f.get("break") || 0),
            leaveTypeId: f.get("leaveType") || null,
            leaveMinutes: Number(f.get("leave") || 0) * 60,
            notes: f.get("notes"),
          }),
        }),
      "حضور روزانه محاسبه و ذخیره شد",
    );
    setShow(false);
  };
  const saveOverride = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!override) return;
    const form = new FormData(event.currentTarget);
    run(
      () => request("/attendance", {
        method: "POST",
        body: JSON.stringify({
          employeeId: override.employee_id,
          workDate: override.work_date,
          checkInMinute: override.check_in_minute,
          checkOutMinute: override.check_out_minute,
          breakMinutes: override.break_minutes,
          leaveTypeId: override.leave_type_id,
          leaveMinutes: override.leave_minutes,
          notes: override.notes,
          overrideStatus: form.get("status"),
          overrideReason: form.get("reason"),
        }),
      }),
      "اصلاح دستی همراه با دلیل ثبت شد",
    );
    setOverride(null);
  };
  return (
    <PagePanel
      title="حضور و غیاب روزانه"
      subtitle="ورود، خروج و محاسبات خودکار"
      action={
        <div className="actions">
          <input
            className="date-input"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button className="primary-button" onClick={() => setShow(!show)}>
            ＋ ثبت حضور
          </button>
        </div>
      }
    >
      {show && (
        <form className="inline-form attendance-form" onSubmit={submit}>
          <label>
            <span>کارمند</span>
            <select name="employeeId" required>
              {employees.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.fullName} — {x.personnelCode}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="تاریخ"
            name="date"
            type="date"
            defaultValue={date}
            required
          />
          <Field label="ورود" name="in" type="time" />
          <Field label="خروج" name="out" type="time" />
          <Field
            label="استراحت (دقیقه)"
            name="break"
            type="number"
            defaultValue={String(config.schedules[0]?.breakMinutes ?? 60)}
          />
          <label>
            <span>نوع مرخصی</span>
            <select name="leaveType">
              <option value="">بدون مرخصی</option>
              {config.leaveTypes.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="مرخصی (ساعت)"
            name="leave"
            type="number"
            defaultValue="0"
          />
          <Field label="توضیحات" name="notes" />
          <button disabled={busy} className="primary-button">
            محاسبه و ذخیره
          </button>
        </form>
      )}
      {override && (
        <form className="inline-form danger-form" onSubmit={saveOverride}>
          <p>اصلاح وضعیت «{override.fullName}» برای {override.work_date}; دلیل تغییر در Audit Log ثبت می‌شود.</p>
          <label><span>وضعیت اصلاح‌شده</span><select name="status" defaultValue={override.override_status ?? override.computed_status}><option value="present">حاضر</option><option value="absent">غایب</option><option value="leave">مرخصی</option><option value="holiday">تعطیل</option><option value="incomplete">ناقص</option></select></label>
          <Field label="دلیل اصلاح" name="reason" required />
          <button disabled={busy} className="primary-button">ثبت اصلاح</button>
          <button type="button" className="secondary-button compact" onClick={() => setOverride(null)}>انصراف</button>
        </form>
      )}
      <AttendanceTable rows={items} employees={employees} onOverride={setOverride} />
    </PagePanel>
  );
}
function AttendanceTable({ rows, employees, onOverride }: { rows: Attendance[]; employees: Employee[]; onOverride?: (row: Attendance) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>کارمند</th>
            <th>ورود</th>
            <th>خروج</th>
            <th>کار واقعی</th>
            <th>کسری</th>
            <th>اضافه‌کاری</th>
            <th>وضعیت</th>
            {onOverride && <th>عملیات</th>}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((x) => {
              // Google Sheets returns camelCase while the legacy local API used snake_case.
              // Keep the table compatible with both sources during the migration.
              const record = x as Attendance & Record<string, any>;
              const employee = employees.find((item) => item.id === (record.employee_id ?? record.employeeId));
              const fullName = record.fullName ?? employee?.fullName ?? "Unknown employee";
              const personnelCode = record.personnelCode ?? employee?.personnelCode ?? "Not Available in System";
              const s = record.override_status ?? record.overrideStatus ?? record.computed_status ?? record.computedStatus ?? "pending";
              return (
                <tr key={x.id}>
                  <td>
                    <div className="person">
                      <span>{fullName[0] ?? "?"}</span>
                      <div>
                        <strong>{fullName}</strong>
                        <small>{personnelCode}</small>
                      </div>
                    </div>
                  </td>
                  <td>{min(record.check_in_minute ?? record.checkInMinute)}</td>
                  <td>{min(record.check_out_minute ?? record.checkOutMinute)}</td>
                  <td>{min(record.actual_minutes ?? record.actualMinutes)}</td>
                  <td>{min(record.deficit_minutes ?? record.deficitMinutes)}</td>
                  <td>{min(record.overtime_minutes ?? record.overtimeMinutes)}</td>
                  <td>
                    <span className={`badge ${s}`}>{statusFa[s] ?? s}</span>
                  </td>
                  {onOverride && <td><button className="link-button" onClick={() => onOverride(x)}>اصلاح</button></td>}
                </tr>
              );
            })
          ) : (
            <tr>
              <td colSpan={onOverride ? 8 : 7}>
                <Empty text="برای این تاریخ رکوردی وجود ندارد" />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CalendarPage({
  config,
  employees,
  busy,
  run,
  view,
}: {
  config: Config;
  employees: Employee[];
  busy: boolean;
  run: any;
  view: "calendar" | "rules";
}) {
  const [show, setShow] = useState(false);
  const [showLeave, setShowLeave] = useState(false);
  const [showHoliday, setShowHoliday] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Config["schedules"][number] | null>(null);
  const [weeklyOffDays, setWeeklyOffDays] = useState<number[] | null>(null);
  const [selectedDay, setSelectedDay] = useState<{
    value: string;
    holiday?: { id: string; date: string; title: string };
    override?: Config["overrides"][number];
  } | null>(null);
  const [dayMode, setDayMode] = useState<"holiday" | "work">("work");
  const [dayScheduleId, setDayScheduleId] = useState("");
  const [dayEmployeeId, setDayEmployeeId] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(
    new Date(now.getFullYear(), now.getMonth(), 1),
  );
  const defaultSchedule =
    config.schedules.find((x) => x.isDefault) ?? config.schedules[0];
  const configuredWeeklyOffDays = useMemo(() => {
    if (!defaultSchedule) return [0, 6];
    const configured = defaultSchedule.workDays ?? [];
    return [0, 1, 2, 3, 4, 5, 6].filter((day) => !configured.includes(day));
  }, [defaultSchedule]);
  const selectedWeeklyOffDays = weeklyOffDays ?? configuredWeeklyOffDays;
  const calendarDays = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    // Canadian calendars start the week on Sunday.
    const firstWeekday = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    const statutoryHolidays = ontarioPublicHolidays(year);
    return [
      ...Array.from({ length: firstWeekday }, () => null),
      ...Array.from({ length: totalDays }, (_, index) => {
        const date = new Date(year, month, index + 1);
        const value = isoDate(date);
        const customHoliday = config.holidays.find(
          (x) => String(x.date).slice(0, 10) === value,
        );
        const holiday = customHoliday ?? statutoryHolidays.find((x) => x.date === value);
        const override = (config.overrides ?? []).find(
          (x) => String(x.date).slice(0, 10) === value,
        );
        const configuredDays = defaultSchedule?.workDays ?? [];
        // Keep existing five-day defaults compatible with the Persian workweek (Sat–Thu).
        const scheduleWorkday = configuredDays.includes(date.getDay());
        const isWorkday =
          weeklyOffDays !== null
            ? !selectedWeeklyOffDays.includes(date.getDay())
            : !selectedWeeklyOffDays.includes(date.getDay()) && scheduleWorkday;
        return { date, value, holiday, override, isWorkday };
      }),
    ];
  }, [
    calendarMonth,
    config.holidays,
    config.overrides,
    defaultSchedule,
    selectedWeeklyOffDays,
    weeklyOffDays,
  ]);
  const monthLabel = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "long",
  }).format(calendarMonth);
  const saveDaySetting = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedDay) return;
    const data = new FormData(e.currentTarget);
    run(
      () =>
        request("/schedule-overrides", {
          method: "POST",
          body: JSON.stringify({
            employeeId: dayEmployeeId || null,
            workDate: selectedDay.value,
            scheduleId:
              dayMode === "holiday"
                ? null
                : dayScheduleId || defaultSchedule?.id,
            isHoliday: dayMode === "holiday",
            reason: data.get("reason"),
          }),
        }),
      dayMode === "holiday" ? "روز به‌عنوان تعطیل ثبت شد" : "شیفت روز ثبت شد",
    );
    setSelectedDay(null);
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(
      () =>
        request(editingSchedule ? `/schedules/${editingSchedule.id}` : "/schedules", {
          method: editingSchedule ? "PUT" : "POST",
          body: JSON.stringify({
            ...(editingSchedule ? { id: editingSchedule.id } : {}),
            name: f.get("name"),
            startMinute: toMin(String(f.get("start"))),
            endMinute: toMin(String(f.get("end"))),
            breakMinutes: Number(f.get("break")),
            workDays: [0, 1, 2, 3, 4, 5, 6].filter(
              (day) => !selectedWeeklyOffDays.includes(day),
            ),
            isDefault: true,
          }),
        }),
      "شیفت جدید ثبت شد",
    );
    setShow(false);
    setEditingSchedule(null);
  };
  const removeSchedule = (schedule: Config["schedules"][number]) => {
    if (!window.confirm(`حذف شیفت «${schedule.name}» انجام شود؟`)) return;
    void run(
      () => request(`/schedules/${schedule.id}`, { method: "DELETE", body: JSON.stringify({ reason: "حذف شیفت" }) }),
      "شیفت حذف شد",
    );
  };
  const saveWeeklyDays = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!defaultSchedule) return;
    const data = new FormData(e.currentTarget);
    const offDays = data.getAll("offDay").map(Number);
    setWeeklyOffDays(offDays);
    run(
      () =>
        request(`/schedules/${defaultSchedule.id}`, {
          method: "PUT",
          body: JSON.stringify({
            id: defaultSchedule.id,
            name: defaultSchedule.name,
            startMinute: defaultSchedule.startMinute,
            endMinute: defaultSchedule.endMinute,
            breakMinutes: defaultSchedule.breakMinutes,
            workDays: [0, 1, 2, 3, 4, 5, 6].filter(
              (day) => !offDays.includes(day),
            ),
            isDefault: true,
          }),
        }),
      "تعطیلات هفتگی ذخیره شد",
    );
  };
  const addLeave = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    run(
      () =>
        request("/leave-types", {
          method: "POST",
          body: JSON.stringify({
            name: data.get("name"),
            unit: data.get("unit"),
            isPaid: data.get("isPaid") === "on",
          }),
        }),
      "نوع مرخصی ثبت شد",
    );
    setShowLeave(false);
  };
  const addHoliday = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    run(
      () =>
        request("/holidays", {
          method: "POST",
          body: JSON.stringify({
            date: data.get("date"),
            title: data.get("title"),
          }),
        }),
      "تعطیلی ثبت شد",
    );
    setShowHoliday(false);
  };
  return (
    <div className={`split-pages${view === "calendar" ? " calendar-page-layout" : ""}`}>
      <PagePanel
        title={view === "calendar" ? "تقویم کاری" : "شیفت و مرخصی"}
        subtitle={
          view === "calendar"
            ? "انتخاب روز برای تعیین تعطیلی یا شیفت کاری"
            : "شیفت، روزهای کاری و استراحت"
        }
        action={
          view === "rules" ? (
            <button className="primary-button" onClick={() => setShow(!show)}>
              ＋ شیفت جدید
            </button>
          ) : undefined
        }
      >
        {view === "calendar" && (
          <form className="weekly-days-form" onSubmit={saveWeeklyDays}>
            <div>
              <strong>تعطیلات هفتگی</strong>
              <p>
                هر تعداد روزی را که انتخاب کنید، در تمام تقویم به‌عنوان تعطیل
                اعمال می‌شود.
              </p>
            </div>
            <div className="weekday-checkboxes">
              {weekDaysCanada.map((day, jsDay) => {
                return (
                  <label key={day}>
                    <input
                      type="checkbox"
                      name="offDay"
                      value={jsDay}
                      checked={selectedWeeklyOffDays.includes(jsDay)}
                      onChange={(event) =>
                        setWeeklyOffDays((current) => {
                          const selected = current ?? configuredWeeklyOffDays;
                          return event.target.checked
                            ? [...new Set([...selected, jsDay])]
                            : selected.filter((dayValue) => dayValue !== jsDay);
                        })
                      }
                    />
                    <span>{day}</span>
                  </label>
                );
              })}
            </div>
            <button
              disabled={busy || !defaultSchedule}
              className="primary-button"
            >
              ذخیره روزهای تعطیل
            </button>
          </form>
        )}
        {view === "rules" && show && (
          <form className="inline-form" onSubmit={submit} key={editingSchedule?.id ?? "new-schedule"}>
            <Field label="نام شیفت" name="name" required />
            <Field
              label="شروع"
              name="start"
              type="time"
              defaultValue={editingSchedule ? min(editingSchedule.startMinute) : "08:00"}
              required
            />
            <Field
              label="پایان"
              name="end"
              type="time"
              defaultValue={editingSchedule ? min(editingSchedule.endMinute) : "17:00"}
              required
            />
            <Field
              label="استراحت"
              name="break"
              type="number"
              defaultValue={String(editingSchedule?.breakMinutes ?? 60)}
              required
            />
            <button disabled={busy} className="primary-button">
              ذخیره
            </button>
          </form>
        )}
        {view === "rules" && (
          <div className="cards-list">
            {config.schedules.map((s) => (
              <article key={s.id}>
                <span className="schedule-icon">◷</span>
                <div>
                  <strong>{scheduleTitleFa(s.name)}</strong>
                  <p>
                    {min(s.startMinute)} تا {min(s.endMinute)} •{" "}
                    {s.breakMinutes} دقیقه استراحت
                  </p>
                </div>
                <div className="card-actions">
                  <button type="button" className="secondary-button compact" onClick={() => { setEditingSchedule(s); setShow(true); }}>ویرایش</button>
                  <button type="button" className="danger-button compact" onClick={() => removeSchedule(s)}>حذف</button>
                </div>
                {s.isDefault && (
                  <span className="badge processing">پیش‌فرض</span>
                )}
              </article>
            ))}
          </div>
        )}
        {view === "calendar" && (
          <div className="calendar-preview">
            <div className="calendar-toolbar">
              <button
                className="calendar-nav"
                aria-label="ماه قبل"
                onClick={() =>
                  setCalendarMonth(
                    new Date(
                      calendarMonth.getFullYear(),
                      calendarMonth.getMonth() - 1,
                      1,
                    ),
                  )
                }
              >
                ‹
              </button>
              <strong>{monthLabel}</strong>
              <button
                className="calendar-nav"
                aria-label="ماه بعد"
                onClick={() =>
                  setCalendarMonth(
                    new Date(
                      calendarMonth.getFullYear(),
                      calendarMonth.getMonth() + 1,
                      1,
                    ),
                  )
                }
              >
                ›
              </button>
            </div>
            <div className="calendar-weekdays">
              {weekDaysCanada.map((day, jsDay) => {
                const configuredDays = defaultSchedule?.workDays ?? [];
                const scheduleWorkday = configuredDays.includes(jsDay);
                const isWorkday =
                  weeklyOffDays !== null
                    ? !selectedWeeklyOffDays.includes(jsDay)
                    : !selectedWeeklyOffDays.includes(jsDay) && scheduleWorkday;
                return (
                  <span className={isWorkday ? "workday" : "weekend"} key={day}>
                    <strong>{day}</strong>
                    <small>{isWorkday ? "کاری" : "تعطیل"}</small>
                  </span>
                );
              })}
            </div>
            <div className="calendar-grid">
              {calendarDays.map((item, index) =>
                item ? (
                  <div
                    className={`calendar-day ${item.value === today ? "today" : ""} ${
                      item.holiday || item.override?.isHoliday ? "holiday" : ""
                    }`}
                    key={item.value}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelectedDay(item);
                      setDayMode(
                        item.override?.isHoliday || item.holiday
                          ? "holiday"
                          : "work",
                      );
                      setDayScheduleId(
                        item.override?.scheduleId ?? defaultSchedule?.id ?? "",
                      );
                      setDayEmployeeId("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        setSelectedDay(item);
                        setDayMode(
                          item.override?.isHoliday || item.holiday
                            ? "holiday"
                            : "work",
                        );
                        setDayScheduleId(
                          item.override?.scheduleId ??
                            defaultSchedule?.id ??
                            "",
                        );
                        setDayEmployeeId("");
                      }
                    }}
                  >
                    <div className="calendar-day-number">
                      <strong>{item.date.getDate()}</strong>
                      <small>
                        {item.date.toLocaleDateString("en-CA", {
                          weekday: "short",
                        })}
                      </small>
                    </div>
                    {item.override?.isHoliday || item.holiday ? (
                      <span
                        className="calendar-event holiday-event"
                        aria-label="تعطیل"
                      >{holidayTitleFa(item.holiday?.title ?? "تعطیلی")}</span>
                    ) : item.override?.scheduleName ? (
                      <span
                        className="calendar-event work-event"
                        aria-label="روز کاری"
                      >{item.override.scheduleName}</span>
                    ) : item.isWorkday ? (
                      <span
                        className="calendar-event work-event"
                        aria-label="روز کاری"
                      >Work day</span>
                    ) : (
                      <span
                        className="calendar-event weekend-event"
                        aria-label="تعطیل هفتگی"
                      >Weekend</span>
                    )}
                  </div>
                ) : (
                  <div
                    className="calendar-day empty-day"
                    key={`empty-${index}`}
                  />
                ),
              )}
            </div>
            <div className="calendar-legend">
              <span>
                <i className="legend-dot work-dot" />
                روز کاری
              </span>
              <span>
                <i className="legend-dot holiday-dot" />
                تعطیلی ثبت‌شده
              </span>
              <span>
                <i className="legend-dot weekend-dot" />
                تعطیل هفتگی
              </span>
            </div>
          </div>
        )}
        {selectedDay && (
          <div className="modal-backdrop" role="presentation">
            <div
              className="calendar-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="calendar-dialog-title"
            >
              <div className="dialog-head">
                <div>
                  <span className="eyebrow">تنظیم روز تقویم</span>
                  <h3 id="calendar-dialog-title">
                    {new Intl.DateTimeFormat("en-CA", {
                      weekday: "long",
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    }).format(new Date(`${selectedDay.value}T12:00:00`))}
                  </h3>
                </div>
                <button
                  className="dialog-close"
                  aria-label="بستن"
                  onClick={() => setSelectedDay(null)}
                >
                  ×
                </button>
              </div>
              <form className="calendar-dialog-form" onSubmit={saveDaySetting}>
                <label htmlFor="calendar-employee">
                  <span>دامنه اعمال</span>
                  <select id="calendar-employee" value={dayEmployeeId} onChange={(event) => setDayEmployeeId(event.target.value)}>
                    <option value="">همه کارکنان (تقویم عمومی)</option>
                    {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName} — {employee.personnelCode}</option>)}
                  </select>
                  {dayEmployeeId && <small>این استثناء فقط در محاسبه حضور و حقوق همین کارمند اعمال می‌شود.</small>}
                </label>
                <div className="day-choice-group">
                  <label
                    aria-label="شیفت کاری"
                    className={dayMode === "work" ? "selected" : ""}
                  >
                    <input
                      type="radio"
                      name="dayMode"
                      checked={dayMode === "work"}
                      onChange={() => setDayMode("work")}
                    />
                    <span>
                      <strong>شیفت کاری</strong>
                      <small>این روز طبق شیفت انتخابی محاسبه شود</small>
                    </span>
                  </label>
                  <label
                    aria-label="تعطیل"
                    className={
                      dayMode === "holiday" ? "selected holiday-choice" : ""
                    }
                  >
                    <input
                      type="radio"
                      name="dayMode"
                      checked={dayMode === "holiday"}
                      onChange={() => setDayMode("holiday")}
                    />
                    <span>
                      <strong>تعطیل</strong>
                      <small>ساعت موظف این روز صفر باشد</small>
                    </span>
                  </label>
                </div>
                {dayMode === "work" && (
                  <label htmlFor="calendar-schedule">
                    <span>شیفت کاری</span>
                    <select
                      id="calendar-schedule"
                      value={dayScheduleId}
                      onChange={(event) => setDayScheduleId(event.target.value)}
                      required
                    >
                      {config.schedules.map((schedule) => (
                        <option key={schedule.id} value={schedule.id}>
                          {scheduleTitleFa(schedule.name)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label htmlFor="calendar-reason">
                  <span>دلیل تغییر</span>
                  <input
                    id="calendar-reason"
                    name="reason"
                    required
                    minLength={2}
                    placeholder="مثلاً تعطیلی مناسبتی"
                  />
                </label>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setSelectedDay(null)}
                  >
                    انصراف
                  </button>
                  <button disabled={busy} className="primary-button">
                    ذخیره تنظیم روز
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </PagePanel>
      {view === "rules" && (
        <div className="stacked-panels">
          <PagePanel
            title="انواع مرخصی"
            subtitle="ساعتی، روزانه و حقوقی"
            action={
              <button
                className="link-button"
                onClick={() => setShowLeave(!showLeave)}
              >
                ＋ افزودن
              </button>
            }
          >
            {showLeave && (
              <form className="inline-form compact-form" onSubmit={addLeave}>
                <Field label="نام نوع مرخصی" name="name" required />
                <label>
                  <span>واحد</span>
                  <select name="unit">
                    <option value="hourly">ساعتی</option>
                    <option value="daily">روزانه</option>
                  </select>
                </label>
                <label className="checkbox-field">
                  <input name="isPaid" type="checkbox" defaultChecked /> با حقوق
                </label>
                <button disabled={busy} className="primary-button">
                  ذخیره
                </button>
              </form>
            )}
            <div className="cards-list">
              {config.leaveTypes.map((x) => (
                <article key={x.id}>
                  <span className="schedule-icon leave-icon">◫</span>
                  <div>
                    <strong>{leaveTitleFa(x)}</strong>
                    <p>
                      {x.unit === "hourly" ? "ساعتی" : "روزانه"} •{" "}
                      {x.isPaid ? "با حقوق" : "بدون حقوق"}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </PagePanel>
          <PagePanel
            title="روزهای تعطیل"
            subtitle={`${config.holidays.length} روز تعریف‌شده`}
            action={
              <button
                className="link-button"
                onClick={() => setShowHoliday(!showHoliday)}
              >
                ＋ افزودن
              </button>
            }
          >
            {showHoliday && (
              <form className="inline-form compact-form" onSubmit={addHoliday}>
                <Field
                  label="تاریخ"
                  name="date"
                  type="date"
                  defaultValue={today}
                  required
                />
                <Field label="عنوان تعطیلی" name="title" required />
                <button disabled={busy} className="primary-button">
                  ذخیره
                </button>
              </form>
            )}
            <div className="cards-list compact-list">
              {config.holidays.length ? (
                config.holidays.map((x) => (
                  <article key={x.id}>
                    <span className="schedule-icon holiday-icon">▦</span>
                    <div>
                      <strong>{holidayTitleFa(x.title)}</strong>
                      <p>{String(x.date).slice(0, 10)}</p>
                    </div>
                  </article>
                ))
              ) : (
                <Empty text="تعطیلی ثبت نشده است" />
              )}
            </div>
          </PagePanel>
        </div>
      )}
    </div>
  );
}

function PayrollPage({
  monthly,
  formulas,
  periods,
  busy,
  run,
}: {
  monthly: Monthly[];
  formulas: Formula[];
  periods: Period[];
  busy: boolean;
  run: any;
}) {
  const [showReopen, setShowReopen] = useState(false);
  const current = periods.find(
    (p) => p.year === now.getFullYear() && p.month === now.getMonth() + 1,
  );
  const process = () =>
    run(
      () =>
        request("/payroll/process", {
          method: "POST",
          body: JSON.stringify({
            year: now.getFullYear(),
            month: now.getMonth() + 1,
          }),
        }),
      `حقوق ${monthly.length} کارمند محاسبه شد`,
    );
  const lock = () =>
    current &&
    run(
      () =>
        request(`/payroll/${current.id}/lock`, { method: "POST", body: "{}" }),
      "دوره حقوق نهایی و snapshot آن قفل شد",
    );
  const reopen = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get("reason") ?? "");
    if (!current || !reason.trim()) return;
    run(
      () =>
        request(`/payroll/${current.id}/reopen`, {
          method: "POST",
          body: JSON.stringify({ reason }),
        }),
      "دوره بازگشایی شد",
    );
    setShowReopen(false);
  };
  return (
    <PagePanel
      title="پردازش حقوق ماهانه"
      subtitle={`${now.getFullYear()} / ${now.getMonth() + 1} • ${formulas.length} مولفه فعال`}
      action={
        <div className="actions">
          <span
            className={`badge ${current?.status === "locked" ? "present" : "processing"}`}
          >
            {current?.status === "locked" ? "نهایی‌شده" : "پیش‌نویس"}
          </span>
          <button
            disabled={busy || !formulas.length || current?.status === "locked"}
            className="primary-button"
            onClick={process}
          >
            ↻ محاسبه حقوق
          </button>
          {current &&
            current.resultCount > 0 &&
            (current.status === "locked" ? (
              <button
                className="secondary-button compact"
                onClick={() => setShowReopen(!showReopen)}
              >
                بازگشایی
              </button>
            ) : (
              <button className="secondary-button compact" onClick={lock}>
                نهایی‌سازی
              </button>
            ))}
        </div>
      }
    >
      <div className="notice">
        پیش از محاسبه، اطلاعات حضور و فرمول‌ها کنترل می‌شوند. نهایی‌سازی،
        snapshot کامل داده‌ها و نسخه فرمول‌ها را قفل می‌کند.
      </div>
      {showReopen && current && (
        <form className="inline-form compact-form" onSubmit={reopen}>
          <Field label="دلیل بازگشایی دوره" name="reason" required />
          <button disabled={busy} className="primary-button">
            بازگشایی دوره
          </button>
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => setShowReopen(false)}
          >
            انصراف
          </button>
        </form>
      )}
      {current && (
        <section className="pay-summary">
          <div>
            <span>تعداد فیش</span>
            <strong>{current.resultCount}</strong>
          </div>
          <div>
            <span>جمع پرداخت‌ها</span>
            <strong>{money(current.earnings)}</strong>
          </div>
          <div>
            <span>جمع کسورات</span>
            <strong>{money(current.deductions)}</strong>
          </div>
          <div>
            <span>خالص پرداختی</span>
            <strong>{money(current.netPay)}</strong>
          </div>
        </section>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>کارمند</th>
              <th>روز ثبت‌شده</th>
              <th>روز موظف</th>
              <th>ساعت موظف</th>
              <th>کار واقعی</th>
              <th>مرخصی</th>
              <th>کسری</th>
              <th>اضافه‌کاری</th>
            </tr>
          </thead>
          <tbody>
            {monthly.map((x) => (
              <tr key={x.id}>
                <td>
                  <strong>{x.fullName}</strong>
                  <small className="block">{x.personnelCode}</small>
                </td>
                <td>{x.recordedDays}</td>
                <td>{x.requiredDays}</td>
                <td>{min(x.scheduledMinutes)}</td>
                <td>{min(x.actualMinutes)}</td>
                <td>{min(x.leaveMinutes)}</td>
                <td>{min(x.deficitMinutes)}</td>
                <td>{min(x.overtimeMinutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PagePanel>
  );
}

function PayslipsPage({ items }: { items: Payslip[] }) {
  const [selected, setSelected] = useState<Payslip | null>(null);
  return (
    <PagePanel
      title="فیش‌های حقوق"
      subtitle="نتایج محاسبه‌شده و ذخیره‌شده در PostgreSQL برای دوره جاری"
    >
      <div className="table-wrap">
        <table>
          <thead><tr><th>کارمند</th><th>پرداخت‌ها</th><th>کسورات</th><th>خالص پرداختی</th><th>جزئیات</th></tr></thead>
          <tbody>{items.length ? items.map((item) => (
            <tr key={item.id}>
              <td><strong>{item.fullName}</strong><small className="block">{item.personnelCode}</small></td>
              <td>{money(item.earnings)}</td><td>{money(item.deductions)}</td><td><strong>{money(item.netPay)}</strong></td>
              <td><button className="secondary-button compact" onClick={() => setSelected(item)}>مشاهده</button></td>
            </tr>
          )) : <tr><td colSpan={5}><Empty text="برای دوره جاری هنوز فیشی محاسبه نشده است" /></td></tr>}</tbody>
        </table>
      </div>
      {selected && (
        <div className="modal-backdrop" role="presentation">
          <div className="calendar-dialog" role="dialog" aria-modal="true" aria-labelledby="payslip-title">
            <div className="dialog-head"><div><span className="eyebrow">فیش حقوق</span><h3 id="payslip-title">{selected.fullName}</h3></div><button className="dialog-close" aria-label="بستن" onClick={() => setSelected(null)}>×</button></div>
            <div className="pay-summary"><div><span>پرداخت</span><strong>{money(selected.earnings)}</strong></div><div><span>کسورات</span><strong>{money(selected.deductions)}</strong></div><div><span>خالص</span><strong>{money(selected.netPay)}</strong></div></div>
            <div className="formula-list preview-trace">
              {selected.componentResults.length ? selected.componentResults.map((result) => <article key={result.code}><span className={`kind-icon ${result.kind}`}>{result.kind === "deduction" ? "-" : "+"}</span><div><strong>{result.name}</strong><code>{result.expression}</code></div><span className="version">{money(result.value)}</span></article>) : <p className="empty-state">جزئیات فرمول برای این فیش در دادهٔ ذخیره‌شده موجود نیست.</p>}
            </div>
          </div>
        </div>
      )}
    </PagePanel>
  );
}

function FormulaPage({
  items,
  employees,
  busy,
  run,
}: {
  items: Formula[];
  employees: Employee[];
  busy: boolean;
  run: any;
}) {
  const [show, setShow] = useState(false);
  const [editingFormula, setEditingFormula] = useState<Formula | null>(null);
  const [preview, setPreview] = useState<{
    trace: { code: string; name: string; kind: string; value: number; expression: string }[];
    earnings: number;
    deductions: number;
    netPay: number;
  } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [builderMode, setBuilderMode] = useState<"binary" | "if" | "min" | "max" | "round">("binary");
  const [builderVariable, setBuilderVariable] = useState("base_salary");
  const [builderOperator, setBuilderOperator] = useState("*");
  const [conditionOperator, setConditionOperator] = useState(">");
  const [builderValue, setBuilderValue] = useState("1");
  const [builderThreshold, setBuilderThreshold] = useState("0");
  const [builderOtherwise, setBuilderOtherwise] = useState("0");
  const customVariables = [...new Set(employees.flatMap((employee) => Object.keys(employee.customValues ?? {})))];
  const customVariableKinds = new Map(
    employees.flatMap((employee) => Object.entries(employee.customValueKinds ?? {})),
  );
  const variables: Array<[string, string]> = [
    ["base_salary", "حقوق پایه"],
    ["overtime_minutes", "دقایق اضافه‌کاری"],
    ["deficit_minutes", "دقایق کسری"],
    ["actual_minutes", "دقایق کار واقعی"],
    ["present_days", "روزهای حضور"],
    ["absent_days", "روزهای غیبت"],
    ["paid_leave_minutes", "دقایق مرخصی باحقوق"],
    ["unpaid_leave_minutes", "دقایق مرخصی بدون‌حقوق"],
    ...customVariables.map((name): [string, string] => [name, `${customVariableKinds.get(name) === "deduction" ? "کسورات ثابت" : "پرداخت یا مزایا"}: ${name}`]),
    ...items.map((item): [string, string] => [item.code, `نتیجه مولفه: ${item.name}`]),
  ];
  const selectedVariableLabel = variables.find(([value]) => value === builderVariable)?.[1] ?? "مقدار انتخاب‌شده";
  const conditionLabels: Record<string, string> = {
    ">": "بیشتر از",
    "<": "کمتر از",
    "==": "برابر با",
    ">=": "بزرگ‌تر یا برابر با",
    "<=": "کوچک‌تر یا برابر با",
  };
  const formulaSentence =
    builderMode === "if"
      ? `اگر «${selectedVariableLabel}» ${conditionLabels[conditionOperator]} ${builderThreshold || 0} بود، مبلغ ${builderValue || 0} را حساب کن؛ در غیر این صورت ${builderOtherwise || 0}.`
      : builderMode === "min"
        ? `کمترِ «${selectedVariableLabel}» و عدد ${builderValue || 0} را انتخاب کن.`
        : builderMode === "max"
          ? `بیشترِ «${selectedVariableLabel}» و عدد ${builderValue || 0} را انتخاب کن.`
          : builderMode === "round"
            ? `«${selectedVariableLabel}» را به نزدیک‌ترین عدد کامل گرد کن.`
            : builderOperator === "+"
              ? `به «${selectedVariableLabel}» مبلغ ${builderValue || 0} اضافه کن.`
              : builderOperator === "-"
                ? `از «${selectedVariableLabel}» مبلغ ${builderValue || 0} کم کن.`
                : builderOperator === "/"
                  ? `«${selectedVariableLabel}» را بر ${builderValue || 0} تقسیم کن.`
                  : `«${selectedVariableLabel}» را در ${builderValue || 0} ضرب کن.`;
  const formulaGuide =
    builderMode === "if"
      ? "برای وضعیت‌هایی مثل پاداشِ عبور از یک حد یا کسرِ غیبت از شرط استفاده کنید."
      : builderMode === "min"
        ? "وقتی می‌خواهید سقفِ پرداخت از یک عدد بالاتر نرود، حداقل را انتخاب کنید."
        : builderMode === "max"
          ? "وقتی می‌خواهید حداقل مبلغ تضمین‌شده داشته باشید، حداکثر را انتخاب کنید."
          : builderMode === "round"
            ? "برای حذف اعشار یا کامل‌کردن مبلغ نهایی از گردکردن استفاده کنید."
            : "فقط یک مقدار اصلی، نوع تغییر و عدد یا نرخ مورد نظر را انتخاب کنید؛ نیازی به نوشتن فرمول نیست.";
  const resetBuilder = () => {
    setBuilderMode("binary");
    setBuilderVariable("base_salary");
    setBuilderOperator("*");
    setConditionOperator(">");
    setBuilderValue("1");
    setBuilderThreshold("0");
    setBuilderOtherwise("0");
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const left = { type: "variable", name: String(f.get("variable")) };
    const right = { type: "number", value: Number(f.get("value")) };
    const mode = String(f.get("mode"));
    let expression: any = {
      type: "binary",
      operator: f.get("operator"),
      left,
      right,
    };
    if (mode === "min" || mode === "max")
      expression = { type: "function", name: mode, args: [left, right] };
    if (mode === "round")
      expression = { type: "function", name: "round", args: [left] };
    if (mode === "if")
      expression = {
        type: "if",
        condition: {
          type: "binary",
          operator: f.get("conditionOperator"),
          left,
          right: { type: "number", value: Number(f.get("threshold")) },
        },
        whenTrue: right,
        whenFalse: { type: "number", value: Number(f.get("otherwise")) },
      };
    run(
      () =>
        request("/formulas", {
          method: "POST",
          body: JSON.stringify({
            code: editingFormula?.code ?? `component_${Date.now().toString(36)}`,
            name: f.get("name"),
            kind: f.get("kind"),
            expression,
          }),
        }),
      "نسخه جدید فرمول منتشر شد",
    );
    setShow(false);
    setEditingFormula(null);
  };
  const previewPayroll = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const inputs = Object.fromEntries(
      variables.map(([key]) => [key, Number(form.get(key) ?? 0)]),
    ) as Record<string, number>;
    try {
      setPreviewError("");
      setPreview(
        await request("/formulas/preview", {
          method: "POST",
          body: JSON.stringify({
            definitions: items.map((item) => ({
              code: item.code,
              name: item.name,
              kind: item.kind,
              expression: item.expression,
            })),
            inputs,
          }),
        }),
      );
    } catch (error) {
      setPreview(null);
      setPreviewError(error instanceof Error ? error.message : "خطای پیش‌نمایش");
    }
  };
  return (
    <PagePanel
      title="فرمول‌های حقوق"
      subtitle="فرمول‌سازی امن، نسخه‌بندی‌شده و بدون کدنویسی"
      action={
        <button className="primary-button" onClick={() => { setEditingFormula(null); resetBuilder(); setShow(!show); }}>
          ＋ مولفه جدید
        </button>
      }
    >
      <form className="formula-builder" onSubmit={previewPayroll}>
        <div className="panel-head compact-head">
          <div><h3>پیش‌نمایش محاسبه</h3><p>مقادیر نمونه را وارد کنید تا ورودی‌ها و مراحل هر مولفه دیده شوند.</p></div>
          <button disabled={!items.length || busy} className="secondary-button compact">اجرای پیش‌نمایش</button>
        </div>
        <div className="builder-row">
          {variables.filter(([key]) => !items.some((item) => item.code === key)).map(([key, label]) => (
            <Field key={key} label={label} name={key} type="number" defaultValue="0" />
          ))}
        </div>
        {previewError && <div className="notice error">{previewError}</div>}
        {preview && <div className="formula-list preview-trace">
          {preview.trace.map((entry) => <article key={entry.code}><span className={`kind-icon ${entry.kind}`}>{entry.kind === "deduction" ? "-" : "+"}</span><div><strong>{entry.name}: {money(entry.value)}</strong><small>نتیجه این مرحله از محاسبه</small></div><span className="version">ثبت‌شده</span></article>)}
          <div className="pay-summary"><div><span>پرداخت</span><strong>{money(preview.earnings)}</strong></div><div><span>کسورات</span><strong>{money(preview.deductions)}</strong></div><div><span>خالص</span><strong>{money(preview.netPay)}</strong></div></div>
        </div>}
      </form>
      {show && (
        <form className="formula-builder" onSubmit={submit} key={editingFormula?.id ?? "new"}>
          <div className="formula-guide" role="note">
            <strong>فرمول را با جمله بسازید</strong>
            <p>نیازی به دانستن علامت‌های ریاضی نیست. انتخاب‌های زیر را انجام دهید؛ متنِ نتیجه در پایین به شما نشان می‌دهد چه چیزی محاسبه خواهد شد.</p>
          </div>
          <div className="builder-row">
            <Field label="نام مولفه" name="name" defaultValue={editingFormula?.name ?? ""} required />
            <label>
              <span>نوع مولفه</span>
              <select name="kind">
                <option value="earning">پرداخت</option>
                <option value="deduction">کسورات</option>
                <option value="net">خالص</option>
              </select>
            </label>
            <label>
              <span>چه کاری انجام شود؟</span>
              <select name="mode" value={builderMode} onChange={(event) => setBuilderMode(event.target.value as typeof builderMode)}>
                <option value="binary">یک محاسبه ساده انجام بده</option>
                <option value="if">اگر یک شرط برقرار بود، مبلغ بده</option>
                <option value="min">مبلغ را از یک سقف بیشتر نکن</option>
                <option value="max">حداقل مبلغ را تضمین کن</option>
                <option value="round">مبلغ را گرد کن</option>
              </select>
            </label>
          </div>
          <div className="expression-row advanced">
            <label>
              <span>مقدار اصلی چیست؟</span>
              <select name="variable" value={builderVariable} onChange={(event) => setBuilderVariable(event.target.value)}>
                {variables.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            {builderMode === "binary" && <label>
              <span>با آن چه کنیم؟</span>
              <select name="operator" value={builderOperator} onChange={(event) => setBuilderOperator(event.target.value)}>
                <option value="*">در یک عدد ضرب کن</option>
                <option value="/">بر یک عدد تقسیم کن</option>
                <option value="+">یک مبلغ به آن اضافه کن</option>
                <option value="-">یک مبلغ از آن کم کن</option>
              </select>
            </label>}
            {builderMode === "if" && <label>
              <span>شرط چگونه باشد؟</span>
              <select name="conditionOperator" value={conditionOperator} onChange={(event) => setConditionOperator(event.target.value)}>
                <option value=">">بیشتر از</option>
                <option value="<">کمتر از</option>
                <option value="==">برابر با</option>
                <option value=">=">بزرگ‌تر یا برابر با</option>
                <option value="<=">کوچک‌تر یا برابر با</option>
              </select>
            </label>}
            {builderMode !== "round" && <label>
              <span>{builderMode === "if" ? "مبلغ در صورت برقرار بودن شرط" : "عدد یا مبلغ دوم"}</span>
              <input name="value" type="number" value={builderValue} onChange={(event) => setBuilderValue(event.target.value)} required />
            </label>}
            {builderMode === "if" && <>
              <label>
                <span>آستانه شرط</span>
                <input name="threshold" type="number" value={builderThreshold} onChange={(event) => setBuilderThreshold(event.target.value)} required />
              </label>
              <label>
                <span>مبلغ در غیر این صورت</span>
                <input name="otherwise" type="number" value={builderOtherwise} onChange={(event) => setBuilderOtherwise(event.target.value)} required />
              </label>
            </>}
            <div className="formula-preview formula-sentence"><strong>یعنی:</strong> {formulaSentence}</div>
          </div>
          <p className="formula-help">{formulaGuide}</p>
          <button disabled={busy} className="primary-button">
            اعتبارسنجی و انتشار نسخه
          </button>
        </form>
      )}
      <div className="formula-list">
        {items.length ? (
          items.map((x) => (
            <article key={x.id}>
              <span className={`kind-icon ${x.kind}`}>
                {x.kind === "earning"
                  ? "+"
                  : x.kind === "deduction"
                    ? "-"
                    : "="}
              </span>
              <div>
                <strong>{x.name}</strong>
                <small>فرمول تعریف‌شده و قابل استفاده در محاسبه حقوق</small>
              </div>
              <span className="version">نسخه {x.version}</span>
              <button className="link-button" onClick={() => { setEditingFormula(x); resetBuilder(); setShow(true); }}>ویرایش ساده</button>
            </article>
          ))
        ) : (
          <Empty text="هنوز فرمولی تعریف نشده است" />
        )}
      </div>
    </PagePanel>
  );
}

function ReportsPage({ employees, busy, run }: { employees: Employee[]; busy: boolean; run: any }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [rangeStart, setRangeStart] = useState("2026-04-01");
  const [rangeEnd, setRangeEnd] = useState("2026-09-30");
  const [reportMessage, setReportMessage] = useState("");
  const generate = async (type: string) => {
    if (!employeeId) throw new Error("Select an employee first");
    const response = await fetch(`${API}/reports/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employeeId, start: rangeStart, end: rangeEnd, type }) });
    if (!response.ok) { const failure = await response.json().catch(() => ({})); throw new Error(failure.error ?? "Report generation failed"); }
    const reportId = response.headers.get("X-Report-Id");
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const name = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? `report-${reportId}`;
    const link = document.createElement("a"); link.href = URL.createObjectURL(await response.blob()); link.download = name; link.click(); URL.revokeObjectURL(link.href);
    setReportMessage(`Issued ${name}. Verification ID: ${reportId}`);
  };
  const upload = async (mode: "preview" | "commit") => {
    if (!file) throw new Error("ابتدا فایل را انتخاب کنید");
    const body = new FormData();
    body.append("file", file);
    const res = await fetch(`${API}/import/attendance?mode=${mode}`, {
      method: "POST",
      headers: { "x-session-id": "kara-local" },
      body,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    setPreview(json);
    return json;
  };
  return (
    <div className="report-grid report-workbench">
      <PagePanel title="IRCC-style read-only reports" subtitle="A separate package is produced for exactly one employee. Demo records are always labelled and must not be used for IRCC.">
        <div className="upload-box report-controls">
          <label>Employee<select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}><option value="">Select employee</option>{employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.fullName} ({employee.personnelCode})</option>)}</select></label>
          <div className="form-row"><label>From<input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} /></label><label>To<input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} /></label></div>
          <p>Timezone: <b>America/Toronto</b>. Overlapping pay periods are included; unavailable source fields remain “Not Available in System”.</p>
          <p className="import-result success">Demo data is maintained directly in Google Sheets. Do not run the automated seed again.</p>
          <div className="report-actions">
            {[['detailed-xlsx','01','Detailed time · Excel'],['detailed-pdf','01','Detailed time · PDF'],['period-xlsx','02','Pay-period hours · Excel'],['statement-pdf','03','Statement of earnings · PDF'],['monthly-xlsx','04','Monthly summary · Excel'],['cover-pdf','05','Data source certification · PDF']].map(([type,number,label]) => <button key={type} type="button" className="report-action" disabled={busy || !employeeId} onClick={() => run(() => generate(type), "Report issued and registered")}><span>{number}</span><strong>{label}</strong><small>{type.endsWith("pdf") ? "PDF" : "XLSX"}</small></button>)}
          </div>
          {!employeeId && <p className="report-hint" role="status">Select an employee to enable all report outputs.</p>}
          {reportMessage && <p className="import-result success">{reportMessage}</p>}
          <p><a href="/verify">Verify a report by its report ID and SHA-256 hash</a></p>
        </div>
      </PagePanel>
      <PagePanel
        title="خروجی جامع Excel"
        subtitle="داده‌ها، فیش‌ها، فرمول‌ها و Audit Log"
      >
        <div className="export-card complete-export">
          <span>XL</span>
          <h3>فایل کامل حقوق و دستمزد</h3>
          <p>تمام شیت‌ها راست‌چین و آماده مشاهده در Excel هستند.</p>
          <a className="primary-button download" href={`${API}/export`}>
            ⬇ دریافت فایل Excel
          </a>
        </div>
      </PagePanel>
      <PagePanel title="ورود گروهی حضور" subtitle="اعتبارسنجی پیش از ثبت">
        <div className="upload-box">
          <a className="template-link" href={`${API}/import/template.xlsx`}>
            دریافت قالب استاندارد Excel
          </a>
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p>{file ? file.name : "فایل xlsx را انتخاب کنید"}</p>
          <button
            disabled={busy || !file}
            className="secondary-button"
            onClick={() =>
              run(() => upload("preview"), "اعتبارسنجی فایل انجام شد")
            }
          >
            بررسی فایل
          </button>
          {preview && (
            <div
              className={`import-result ${preview.valid ? "success" : "error"}`}
            >
              {preview.valid
                ? `${preview.totalRows} ردیف معتبر است`
                : `${preview.errors.length} خطا پیدا شد`}
              {preview.valid && (
                <button
                  className="primary-button"
                  onClick={() =>
                    run(() => upload("commit"), "اطلاعات به‌صورت گروهی ثبت شد")
                  }
                >
                  ثبت نهایی
                </button>
              )}
            </div>
          )}
        </div>
      </PagePanel>
    </div>
  );
}

function AuditPage({ items }: { items: Audit[] }) {
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const filtered = items.filter(
    (x) =>
      (!action || x.action === action) &&
      (!entityType || x.entityType === entityType) &&
      (!actor || x.actorId === actor) &&
      (!from || new Date(x.occurredAt) >= new Date(`${from}T00:00:00`)) &&
      (!to || new Date(x.occurredAt) <= new Date(`${to}T23:59:59`)) &&
      (!q ||
        `${x.entityType} ${x.entityId} ${x.reason} ${JSON.stringify(x.beforeValue)} ${JSON.stringify(x.afterValue)}`
          .toLowerCase()
          .includes(q.toLowerCase())),
  );
  return (
    <PagePanel
      title="تاریخچه تغییرات"
      subtitle="لاگ دائمی و غیرقابل‌ویرایش PostgreSQL"
      action={
        <div className="filters">
          <input
            placeholder="جستجو…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">همه عملیات</option>
            <option value="INSERT">ایجاد</option>
            <option value="UPDATE">ویرایش</option>
            <option value="DELETE">حذف</option>
          </select>
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">همه رکوردها</option>
            {Object.entries(entityFa).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          <select value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">همه مدیران</option>
            {[...new Set(items.map((item) => item.actorId))].map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          <input type="date" aria-label="از تاریخ" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" aria-label="تا تاریخ" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      }
    >
      <div className="audit-timeline">
        {filtered.length ? (
          filtered.map((x) => (
            <article key={x.id}>
              <span className={`audit-mark ${x.action.toLowerCase()}`} />
              <div>
                <strong>
                  {actionFa[x.action] ?? x.action}{" "}
                  {entityFa[x.entityType] ?? x.entityType}
                </strong>
                <p>{x.reason || `شناسه رکورد: ${x.entityId}`}</p>
                <small>
                  {new Intl.DateTimeFormat("fa-IR", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(x.occurredAt))}{" "}
                  • {x.actorId} • نشست {x.sessionId || "محلی"}
                </small>
                <details>
                  <summary>مشاهده مقدار قبل و بعد</summary>
                  <div className="audit-json">
                    <pre>{JSON.stringify(x.beforeValue, null, 2) || "—"}</pre>
                    <pre>{JSON.stringify(x.afterValue, null, 2) || "—"}</pre>
                  </div>
                </details>
              </div>
              <span className="immutable">قفل‌شده</span>
            </article>
          ))
        ) : (
          <Empty text="لاگی مطابق فیلتر یافت نشد" />
        )}
      </div>
    </PagePanel>
  );
}

function SettingsPage({
  settings,
  busy,
  run,
}: {
  settings: Settings;
  busy: boolean;
  run: any;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let globalValues: Record<string, number>;
    try {
      const raw = String(data.get("globalValues") ?? "{}").trim() || "{}";
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
        throw new Error();
      globalValues = Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, Number(value)]),
      );
      if (Object.values(globalValues).some((value) => !Number.isFinite(value)))
        throw new Error();
    } catch {
      return;
    }
    run(
      () =>
        request("/settings", {
          method: "PUT",
          body: JSON.stringify({
            currency: data.get("currency"),
            roundingMode: data.get("roundingMode"),
            globalValues,
            reason: data.get("reason"),
          }),
        }),
      "تنظیمات و ثابت‌های عمومی ذخیره شدند",
    );
  };
  return (
    <PagePanel
      title="تنظیمات محاسبات"
      subtitle="واحد پول، روش گردکردن و ثابت‌های عمومی قابل استفاده در فرمول‌ها"
    >
      <form className="formula-builder" onSubmit={submit}>
        <div className="builder-row">
          <label>
            <span>واحد پول</span>
            <select name="currency" defaultValue={settings.currency}>
              <option value="IRR">ریال (IRR)</option>
              <option value="IRT">تومان (IRT)</option>
              <option value="USD">دلار (USD)</option>
              <option value="EUR">یورو (EUR)</option>
            </select>
          </label>
          <label>
            <span>روش گردکردن نهایی</span>
            <select name="roundingMode" defaultValue={settings.roundingMode}>
              <option value="nearest">نزدیک‌ترین عدد</option>
              <option value="up">رو به بالا</option>
              <option value="down">رو به پایین</option>
            </select>
          </label>
          <Field label="دلیل تغییر" name="reason" required />
        </div>
        <CustomValuesEditor
          fieldName="globalValues"
          title="ثابت‌ها و نرخ‌های عمومی"
          initialValues={settings.globalValues}
          showKinds={false}
        />
        <button disabled={busy} className="primary-button">
          ذخیره تنظیمات
        </button>
      </form>
    </PagePanel>
  );
}

function PagePanel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel page-panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function Field(props: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label>
      <span>{props.label}</span>
      <input {...props} aria-label={props.label} />
    </label>
  );
}

function CustomValuesEditor({
  initialValues = {},
  initialKinds = {},
  fieldName = "customValues",
  title = "مقادیر سفارشی",
  showKinds = true,
}: {
  initialValues?: Record<string, number>;
  initialKinds?: Record<string, "earning" | "deduction">;
  fieldName?: string;
  title?: string;
  showKinds?: boolean;
}) {
  const [rows, setRows] = useState(() => {
    const existing = Object.entries(initialValues).map(([label, value]) => ({ label, value: String(value), kind: initialKinds[label] ?? "earning" }));
    return existing.length ? existing : [{ label: "", value: "", kind: "earning" as const }];
  });
  const values = Object.fromEntries(
    rows
      .filter((row) => row.label.trim())
      .map((row) => [row.label.trim(), Number(row.value || 0)]),
  );
  const kinds = Object.fromEntries(
    rows
      .filter((row) => row.label.trim())
      .map((row) => [row.label.trim(), row.kind]),
  );
  return (
    <section className="custom-values-editor" aria-label="مقادیر سفارشی">
      <div className="custom-values-head">
        <div><strong>{title}</strong><p>{showKinds ? "هر مبلغ را به‌عنوان پرداخت/مزایا یا کسورات ثبت کنید؛ بعداً با همین عنوان در فرمول‌ها انتخاب می‌شود." : "مثل نرخ ساعتی، ضریب اضافه‌کاری یا هر عدد مشترک؛ همین عنوان بعداً در فرمول‌ها قابل انتخاب است."}</p></div>
        <button type="button" className="secondary-button compact" onClick={() => setRows((current) => [...current, { label: "", value: "", kind: "earning" }])}>＋ افزودن مبلغ</button>
      </div>
      <input type="hidden" name={fieldName} value={JSON.stringify(values)} readOnly />
      {showKinds && <input type="hidden" name={`${fieldName}Kinds`} value={JSON.stringify(kinds)} readOnly />}
      <div className={`custom-value-columns${showKinds ? "" : " simple"}`} aria-hidden="true"><span>عنوان مبلغ</span><span>مبلغ</span>{showKinds && <><span>نوع اثر در حقوق</span><span /></>}</div>
      {rows.map((row, index) => (
        <div className={`custom-value-row${showKinds ? "" : " simple"}`} key={index}>
          <input aria-label="عنوان مبلغ" placeholder={row.kind === "deduction" ? "مثلاً بیمه یا قسط" : "مثلاً حق مسکن"} value={row.label} onChange={(event) => setRows((current) => current.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} />
          <input aria-label="مبلغ مقدار" type="number" placeholder="مبلغ" value={row.value} onChange={(event) => setRows((current) => current.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />
          {showKinds && <select aria-label="نوع اثر در حقوق" className={`custom-value-kind ${row.kind}`} value={row.kind} onChange={(event) => setRows((current) => current.map((item, i) => i === index ? { ...item, kind: event.target.value as "earning" | "deduction" } : item))}>
              <option value="earning">پرداخت / مزایا</option>
              <option value="deduction">کسورات</option>
            </select>}
          <button type="button" className="danger-link" aria-label="حذف مقدار" onClick={() => setRows((current) => current.length === 1 ? [{ label: "", value: "", kind: "earning" }] : current.filter((_, i) => i !== index))}>حذف</button>
        </div>
      ))}
    </section>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <span>◇</span>
      <p>{text}</p>
    </div>
  );
}
