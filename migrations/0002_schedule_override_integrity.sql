CREATE UNIQUE INDEX IF NOT EXISTS schedule_overrides_global_date_uq
  ON schedule_overrides(work_date)
  WHERE employee_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS schedule_overrides_employee_date_uq
  ON schedule_overrides(employee_id, work_date)
  WHERE employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS schedule_overrides_date_idx
  ON schedule_overrides(work_date, employee_id);
