CREATE OR REPLACE FUNCTION protect_locked_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_date date; affected_employee uuid;
BEGIN
  IF TG_TABLE_NAME = 'employees' THEN
    affected_employee := OLD.id;
    IF EXISTS (SELECT 1 FROM payroll_results r JOIN payroll_periods p ON p.id=r.period_id WHERE p.status='locked' AND r.employee_id=affected_employee) THEN
      RAISE EXCEPTION 'Employee belongs to a locked payroll period';
    END IF;
  ELSIF TG_TABLE_NAME = 'leave_types' THEN
    IF EXISTS (SELECT 1 FROM attendance_entries a JOIN payroll_results r ON r.employee_id=a.employee_id JOIN payroll_periods p ON p.id=r.period_id WHERE p.status='locked' AND a.leave_type_id=OLD.id AND EXTRACT(YEAR FROM a.work_date)=p.year AND EXTRACT(MONTH FROM a.work_date)=p.month) THEN
      RAISE EXCEPTION 'Leave type belongs to a locked payroll period';
    END IF;
  ELSIF TG_TABLE_NAME = 'holidays' THEN
    affected_date := OLD.holiday_date;
    affected_employee := NULL;
    IF EXISTS (SELECT 1 FROM payroll_periods p LEFT JOIN payroll_results r ON r.period_id=p.id WHERE p.status='locked' AND p.year=EXTRACT(YEAR FROM affected_date) AND p.month=EXTRACT(MONTH FROM affected_date) AND (affected_employee IS NULL OR r.employee_id=affected_employee)) THEN
      RAISE EXCEPTION 'Calendar configuration belongs to a locked payroll period';
    END IF;
  ELSIF TG_TABLE_NAME = 'schedule_overrides' THEN
    affected_date := OLD.work_date;
    affected_employee := OLD.employee_id;
    IF EXISTS (SELECT 1 FROM payroll_periods p LEFT JOIN payroll_results r ON r.period_id=p.id WHERE p.status='locked' AND p.year=EXTRACT(YEAR FROM affected_date) AND p.month=EXTRACT(MONTH FROM affected_date) AND (affected_employee IS NULL OR r.employee_id=affected_employee)) THEN
      RAISE EXCEPTION 'Calendar configuration belongs to a locked payroll period';
    END IF;
  ELSIF TG_TABLE_NAME = 'work_schedules' AND EXISTS (SELECT 1 FROM payroll_periods WHERE status='locked') THEN
    RAISE EXCEPTION 'A work schedule cannot be deleted while a payroll period is locked';
  END IF;
  RETURN OLD;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['employees','leave_types','holidays','schedule_overrides','work_schedules'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I','locked_delete_'||t,t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_locked_configuration()','locked_delete_'||t,t);
  END LOOP;
END $$;
