CREATE TABLE IF NOT EXISTS general_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  currency text NOT NULL DEFAULT 'IRR',
  rounding_mode text NOT NULL DEFAULT 'nearest' CHECK (rounding_mode IN ('nearest','up','down')),
  global_values jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO general_settings(id) VALUES (true) ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS audit_general_settings ON general_settings;
CREATE TRIGGER audit_general_settings AFTER INSERT OR UPDATE OR DELETE ON general_settings
FOR EACH ROW EXECUTE FUNCTION write_audit_log();
DROP TRIGGER IF EXISTS updated_at_general_settings ON general_settings;
CREATE TRIGGER updated_at_general_settings BEFORE UPDATE ON general_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
