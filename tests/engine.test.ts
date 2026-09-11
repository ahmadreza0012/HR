import assert from "node:assert/strict";
import test from "node:test";
import { calculateAttendance, evaluatePayroll, isFormulaExpression, type FormulaDefinition } from "../server/engine";

test("محاسبه شیفت عادی، کسری و اضافه‌کاری", () => {
  const full = calculateAttendance({ checkInMinute:480, checkOutMinute:1050, breakMinutes:60, scheduleStart:480, scheduleEnd:1020 });
  assert.deepEqual(full, { actualMinutes:510, requiredMinutes:480, delayMinutes:0, earlyLeaveMinutes:0, deficitMinutes:0, overtimeMinutes:30, status:"present" });
  const short = calculateAttendance({ checkInMinute:500, checkOutMinute:970, breakMinutes:60, scheduleStart:480, scheduleEnd:1020 });
  assert.equal(short.delayMinutes,20); assert.equal(short.earlyLeaveMinutes,50); assert.equal(short.deficitMinutes,70);
});

test("شیفت شب از نیمه شب عبور می‌کند", () => {
  const result=calculateAttendance({checkInMinute:1320,checkOutMinute:360,breakMinutes:30,scheduleStart:1320,scheduleEnd:360});
  assert.equal(result.actualMinutes,450); assert.equal(result.requiredMinutes,450); assert.equal(result.deficitMinutes,0);
});

test("مرخصی بخشی از ساعت موظفی را جبران می‌کند", () => {
  const result=calculateAttendance({checkInMinute:480,checkOutMinute:780,breakMinutes:0,leaveMinutes:180,scheduleStart:480,scheduleEnd:960});
  assert.equal(result.actualMinutes,300);assert.equal(result.deficitMinutes,0);
});

test("تعطیلی و رکورد ناقص وضعیت‌های درست دارند", () => {
  const holiday = calculateAttendance({ scheduleStart: 480, scheduleEnd: 1020, holiday: true });
  assert.equal(holiday.status, "holiday");
  assert.equal(holiday.requiredMinutes, 0);
  const incomplete = calculateAttendance({ checkInMinute: 480, scheduleStart: 480, scheduleEnd: 1020 });
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.deficitMinutes, 540);
});

test("موتور فرمول وابستگی‌ها را مرتب و خالص را محاسبه می‌کند", () => {
  const definitions:FormulaDefinition[]=[
    {code:"tax",name:"مالیات",kind:"deduction",expression:{type:"binary",operator:"*",left:{type:"variable",name:"gross"},right:{type:"number",value:.1}}},
    {code:"gross",name:"حقوق ناخالص",kind:"earning",expression:{type:"binary",operator:"+",left:{type:"variable",name:"base_salary"},right:{type:"variable",name:"overtime_pay"}}},
    {code:"overtime_pay",name:"اضافه کاری",kind:"earning",expression:{type:"binary",operator:"*",left:{type:"variable",name:"overtime_minutes"},right:{type:"number",value:1000}}},
  ];
  const result=evaluatePayroll(definitions,{base_salary:1_000_000,overtime_minutes:60});
  assert.equal(result.context.gross,1_060_000);assert.equal(result.deductions,106_000);assert.equal(result.netPay,1_014_000);
});

test("وابستگی حلقوی و تقسیم بر صفر رد می‌شوند", () => {
  const cycle:FormulaDefinition[]=[{code:"a",name:"الف",kind:"earning",expression:{type:"variable",name:"b"}},{code:"b",name:"ب",kind:"earning",expression:{type:"variable",name:"a"}}];
  assert.throws(()=>evaluatePayroll(cycle,{}),/حلقوی/);
  assert.throws(()=>evaluatePayroll([{code:"x",name:"تقسیم",kind:"earning",expression:{type:"binary",operator:"/",left:{type:"number",value:1},right:{type:"number",value:0}}}],{}),/تقسیم بر صفر/);
});

test("شرط، گردکردن، متغیر نامعتبر و ساختار ناامن فرمول کنترل می‌شوند", () => {
  const definition: FormulaDefinition = {
    code: "bonus", name: "پاداش", kind: "earning", expression: {
      type: "if", condition: { type: "binary", operator: ">", left: { type: "variable", name: "present_days" }, right: { type: "number", value: 20 } },
      whenTrue: { type: "function", name: "round", args: [{ type: "number", value: 1200.5 }] }, whenFalse: { type: "number", value: 0 },
    },
  };
  assert.equal(evaluatePayroll([definition], { present_days: 21 }).earnings, 1201);
  assert.throws(() => evaluatePayroll([{ ...definition, expression: { type: "variable", name: "removed_variable" } }], {}), /موجود نیست/);
  assert.equal(isFormulaExpression({ type: "eval", code: "1+1" }), false);
});
