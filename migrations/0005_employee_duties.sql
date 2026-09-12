ALTER TABLE employees ADD COLUMN IF NOT EXISTS duties text NOT NULL DEFAULT '';

UPDATE employees
SET duties = CASE personnel_code
  WHEN 'EMP-1001' THEN 'مدیریت امور اداری روزانه، پیگیری مکاتبات و هماهنگی بین واحدها.'
  WHEN 'EMP-1002' THEN 'ثبت و کنترل حضور و غیاب، تهیه داده‌های حقوق و پاسخ‌گویی به کارکنان.'
  WHEN 'EMP-1003' THEN 'پشتیبانی عملیات، ثبت درخواست‌ها و پیگیری انجام امور محوله.'
  WHEN 'EMP-1004' THEN 'نظارت بر فرآیندهای مالی، کنترل گزارش‌ها و هماهنگی پرداخت‌ها.'
  ELSE 'انجام وظایف محوله، همکاری با تیم و ثبت گزارش کار.'
END
WHERE duties = '';
