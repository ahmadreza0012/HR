export type FormulaExpression =
  | { type: "number"; value: number }
  | { type: "variable"; name: string }
  | { type: "binary"; operator: "+" | "-" | "*" | "/" | ">" | ">=" | "<" | "<=" | "=="; left: FormulaExpression; right: FormulaExpression }
  | { type: "function"; name: "min" | "max" | "round"; args: FormulaExpression[] }
  | { type: "if"; condition: FormulaExpression; whenTrue: FormulaExpression; whenFalse: FormulaExpression };

export type FormulaDefinition = { code: string; name: string; kind: "earning" | "deduction" | "net"; expression: FormulaExpression };
export type FormulaTrace = { code: string; name: string; kind: string; value: number; expression: string };

/** Validates the JSON formula tree before it is persisted. No executable text is accepted. */
export function isFormulaExpression(value: unknown): value is FormulaExpression {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (node.type === "number") return typeof node.value === "number" && Number.isFinite(node.value);
  if (node.type === "variable")
    return typeof node.name === "string" && /^[\p{L}_][\p{L}\p{N}_ ]*$/u.test(node.name);
  if (node.type === "binary")
    return ["+", "-", "*", "/", ">", ">=", "<", "<=", "=="].includes(String(node.operator)) && isFormulaExpression(node.left) && isFormulaExpression(node.right);
  if (node.type === "if") return isFormulaExpression(node.condition) && isFormulaExpression(node.whenTrue) && isFormulaExpression(node.whenFalse);
  if (node.type === "function")
    return ["min", "max", "round"].includes(String(node.name)) && Array.isArray(node.args) && node.args.length > 0 && node.args.every(isFormulaExpression);
  return false;
}

const finite = (value: number) => {
  if (!Number.isFinite(value)) throw new Error("نتیجه فرمول عدد معتبر نیست");
  return value;
};

export function evaluateExpression(expression: FormulaExpression, context: Record<string, number>): number {
  if (expression.type === "number") return finite(expression.value);
  if (expression.type === "variable") {
    if (!(expression.name in context)) throw new Error(`متغیر «${expression.name}» تعریف نشده است`);
    return finite(Number(context[expression.name]));
  }
  if (expression.type === "if") return evaluateExpression(expression.condition, context) !== 0 ? evaluateExpression(expression.whenTrue, context) : evaluateExpression(expression.whenFalse, context);
  if (expression.type === "function") {
    const args = expression.args.map((arg) => evaluateExpression(arg, context));
    if (expression.name === "min") return Math.min(...args);
    if (expression.name === "max") return Math.max(...args);
    return Math.round(args[0] ?? 0);
  }
  const left = evaluateExpression(expression.left, context);
  const right = evaluateExpression(expression.right, context);
  switch (expression.operator) {
    case "+": return finite(left + right); case "-": return finite(left - right); case "*": return finite(left * right);
    case "/": if (right === 0) throw new Error("تقسیم بر صفر مجاز نیست"); return finite(left / right);
    case ">": return Number(left > right); case ">=": return Number(left >= right); case "<": return Number(left < right); case "<=": return Number(left <= right); case "==": return Number(left === right);
  }
}

export function expressionText(expression: FormulaExpression): string {
  if (expression.type === "number") return String(expression.value);
  if (expression.type === "variable") return expression.name;
  if (expression.type === "binary") return `(${expressionText(expression.left)} ${expression.operator} ${expressionText(expression.right)})`;
  if (expression.type === "if") return `IF(${expressionText(expression.condition)}, ${expressionText(expression.whenTrue)}, ${expressionText(expression.whenFalse)})`;
  return `${expression.name.toUpperCase()}(${expression.args.map(expressionText).join(", ")})`;
}

function references(expression: FormulaExpression): string[] {
  if (expression.type === "variable") return [expression.name];
  if (expression.type === "number") return [];
  if (expression.type === "binary") return [...references(expression.left), ...references(expression.right)];
  if (expression.type === "if") return [...references(expression.condition), ...references(expression.whenTrue), ...references(expression.whenFalse)];
  return expression.args.flatMap(references);
}

export function evaluatePayroll(definitions: FormulaDefinition[], inputs: Record<string, number>) {
  const byCode = new Map(definitions.map((item) => [item.code, item]));
  const completed = new Set<string>(); const visiting = new Set<string>(); const context = { ...inputs }; const trace: FormulaTrace[] = [];
  const visit = (item: FormulaDefinition) => {
    if (completed.has(item.code)) return;
    if (visiting.has(item.code)) throw new Error(`وابستگی حلقوی در مولفه «${item.name}»`);
    visiting.add(item.code);
    for (const ref of references(item.expression)) {
      const dependency = byCode.get(ref);
      if (dependency) visit(dependency);
      else if (!(ref in context)) throw new Error(`متغیر «${ref}» در فرمول «${item.name}» موجود نیست`);
    }
    const value = evaluateExpression(item.expression, context);
    context[item.code] = value; visiting.delete(item.code); completed.add(item.code);
    trace.push({ code: item.code, name: item.name, kind: item.kind, value, expression: expressionText(item.expression) });
  };
  definitions.forEach(visit);
  const earnings = trace.filter((x) => x.kind === "earning").reduce((sum,x) => sum+x.value,0);
  const deductions = trace.filter((x) => x.kind === "deduction").reduce((sum,x) => sum+x.value,0);
  const explicitNet = trace.findLast((x) => x.kind === "net")?.value;
  return { trace, context, earnings, deductions, netPay: explicitNet ?? earnings - deductions };
}

export function calculateAttendance(input: { checkInMinute?: number | null; checkOutMinute?: number | null; breakMinutes?: number; leaveMinutes?: number; scheduleStart: number; scheduleEnd: number; holiday?: boolean }) {
  const { checkInMinute, checkOutMinute, scheduleStart, scheduleEnd } = input;
  const required = input.holiday ? 0 : ((scheduleEnd <= scheduleStart ? scheduleEnd + 1440 : scheduleEnd) - scheduleStart - (input.breakMinutes ?? 0));
  if (input.holiday && checkInMinute == null && checkOutMinute == null) return { actualMinutes:0, requiredMinutes:0, delayMinutes:0, earlyLeaveMinutes:0, deficitMinutes:0, overtimeMinutes:0, status:"holiday" as const };
  if (checkInMinute == null && checkOutMinute == null) {
    const leave = input.leaveMinutes ?? 0; return { actualMinutes:0, requiredMinutes:required, delayMinutes:0, earlyLeaveMinutes:0, deficitMinutes:Math.max(0,required-leave), overtimeMinutes:0, status:(leave>=required ? "leave" : "absent") as "leave"|"absent" };
  }
  if (checkInMinute == null || checkOutMinute == null) return { actualMinutes:0, requiredMinutes:required, delayMinutes:0, earlyLeaveMinutes:0, deficitMinutes:required, overtimeMinutes:0, status:"incomplete" as const };
  const normalizedOut = checkOutMinute <= checkInMinute ? checkOutMinute + 1440 : checkOutMinute;
  const actual = Math.max(0, normalizedOut-checkInMinute-(input.breakMinutes ?? 0));
  const normalizedScheduleEnd = scheduleEnd <= scheduleStart ? scheduleEnd+1440 : scheduleEnd;
  const delay = Math.max(0,checkInMinute-scheduleStart); const early = Math.max(0,normalizedScheduleEnd-normalizedOut);
  const credited = actual+(input.leaveMinutes ?? 0); const deficit = Math.max(0,required-credited); const overtime = Math.max(0,actual-required);
  return { actualMinutes:actual, requiredMinutes:required, delayMinutes:delay, earlyLeaveMinutes:early, deficitMinutes:deficit, overtimeMinutes:overtime, status:"present" as const };
}
