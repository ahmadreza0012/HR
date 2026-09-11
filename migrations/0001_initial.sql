CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE TYPE attendance_status AS ENUM ('present','absent','leave','holiday','incomplete'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE component_kind AS ENUM ('earning','deduction','net'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE period_status AS ENUM ('draft','processing','locked'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS employees (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), personnel_code text NOT NULL UNIQUE, full_name text NOT NULL, employment_status text NOT NULL DEFAULT 'active', start_date date NOT NULL, end_date date, base_salary numeric(18,2) NOT NULL DEFAULT 0, custom_values jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS work_schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, start_minute int NOT NULL CHECK(start_minute BETWEEN 0 AND 1439), end_minute int NOT NULL CHECK(end_minute BETWEEN 0 AND 1439), break_minutes int NOT NULL DEFAULT 0 CHECK(break_minutes >= 0), work_days jsonb NOT NULL DEFAULT '[1,2,3,4,5]', is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS holidays (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), holiday_date date NOT NULL UNIQUE, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS schedule_overrides (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid REFERENCES employees(id) ON DELETE CASCADE, work_date date NOT NULL, schedule_id uuid REFERENCES work_schedules(id), is_holiday boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS leave_types (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, unit text NOT NULL DEFAULT 'hourly' CHECK(unit IN ('hourly','daily')), is_paid boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS attendance_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE, work_date date NOT NULL, check_in_minute int, check_out_minute int, break_minutes int NOT NULL DEFAULT 0, leave_type_id uuid REFERENCES leave_types(id), leave_minutes int NOT NULL DEFAULT 0, actual_minutes int NOT NULL DEFAULT 0, required_minutes int NOT NULL DEFAULT 0, delay_minutes int NOT NULL DEFAULT 0, early_leave_minutes int NOT NULL DEFAULT 0, deficit_minutes int NOT NULL DEFAULT 0, overtime_minutes int NOT NULL DEFAULT 0, computed_status attendance_status NOT NULL, override_status attendance_status, override_reason text, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(employee_id,work_date));
CREATE TABLE IF NOT EXISTS formula_components (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL, kind component_kind NOT NULL, active_version_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS formula_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), component_id uuid NOT NULL REFERENCES formula_components(id) ON DELETE CASCADE, version int NOT NULL, expression jsonb NOT NULL, expression_text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(component_id,version));
CREATE TABLE IF NOT EXISTS payroll_periods (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), year int NOT NULL, month int NOT NULL CHECK(month BETWEEN 1 AND 12), status period_status NOT NULL DEFAULT 'draft', locked_at timestamptz, snapshot jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(year,month));
CREATE TABLE IF NOT EXISTS payroll_results (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), period_id uuid NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE, employee_id uuid NOT NULL REFERENCES employees(id), inputs jsonb NOT NULL, component_results jsonb NOT NULL, earnings numeric(18,2) NOT NULL, deductions numeric(18,2) NOT NULL, net_pay numeric(18,2) NOT NULL, calculated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(period_id,employee_id));
CREATE TABLE IF NOT EXISTS import_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_name text NOT NULL, status text NOT NULL, total_rows int NOT NULL DEFAULT 0, accepted_rows int NOT NULL DEFAULT 0, rejected_rows int NOT NULL DEFAULT 0, errors jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_logs (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(), actor_id text NOT NULL DEFAULT 'local-admin', action text NOT NULL, entity_type text NOT NULL, entity_id text, before_value jsonb, after_value jsonb, reason text, session_id text, batch_id uuid);
CREATE INDEX IF NOT EXISTS idx_attendance_date_employee ON attendance_entries(work_date,employee_id);
CREATE INDEX IF NOT EXISTS idx_audit_occurred_entity ON audit_logs(occurred_at DESC,entity_type);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION write_audit_log() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE row_id text; batch_text text; BEGIN
  row_id := COALESCE(to_jsonb(NEW)->>'id',to_jsonb(OLD)->>'id');
  batch_text := NULLIF(current_setting('app.batch_id',true),'');
  INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,before_value,after_value,reason,session_id,batch_id)
  VALUES(COALESCE(NULLIF(current_setting('app.actor_id',true),''),'local-admin'),TG_OP,TG_TABLE_NAME,row_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END,NULLIF(current_setting('app.reason',true),''),NULLIF(current_setting('app.session_id',true),''),CASE WHEN batch_text IS NULL THEN NULL ELSE batch_text::uuid END);
  RETURN COALESCE(NEW,OLD);
END $$;

CREATE OR REPLACE FUNCTION protect_audit_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_audit_maintenance',true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Audit log is immutable';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION protect_audit_log();

CREATE OR REPLACE FUNCTION protect_locked_attendance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_date date; target_employee uuid; BEGIN
  target_date:=COALESCE(NEW.work_date,OLD.work_date); target_employee:=COALESCE(NEW.employee_id,OLD.employee_id);
  IF EXISTS(SELECT 1 FROM payroll_periods p JOIN payroll_results r ON r.period_id=p.id WHERE p.status='locked' AND r.employee_id=target_employee AND p.year=EXTRACT(YEAR FROM target_date) AND p.month=EXTRACT(MONTH FROM target_date)) THEN
    RAISE EXCEPTION 'Attendance belongs to a locked payroll period';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS attendance_locked_guard ON attendance_entries;
CREATE TRIGGER attendance_locked_guard BEFORE INSERT OR UPDATE OR DELETE ON attendance_entries FOR EACH ROW EXECUTE FUNCTION protect_locked_attendance();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['employees','work_schedules','holidays','schedule_overrides','leave_types','attendance_entries','formula_components','formula_versions','payroll_periods','payroll_results','import_batches'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I','audit_'||t,t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION write_audit_log()','audit_'||t,t);
  END LOOP;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['employees','work_schedules','holidays','schedule_overrides','leave_types','attendance_entries','formula_components','payroll_periods'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I','updated_at_'||t,t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()','updated_at_'||t,t);
  END LOOP;
END $$;

INSERT INTO work_schedules(name,start_minute,end_minute,break_minutes,work_days,is_default) SELECT 'شیفت اداری',480,1020,60,'[1,2,3,4,5]',true WHERE NOT EXISTS(SELECT 1 FROM work_schedules);
INSERT INTO leave_types(name,unit,is_paid) VALUES ('استحقاقی','hourly',true),('استعلاجی','daily',true),('بدون حقوق','daily',false) ON CONFLICT(name) DO NOTHING;
