import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://kara:kara@localhost:5432/kara_payroll",
});

export async function migrate() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const directory = path.resolve("migrations");
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    const applied = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name=$1",
      [name],
    );
    if (applied.rowCount) continue;
    const sql = await readFile(path.join(directory, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  // Keep global calendar overrides visible to the attendance calculator and holidays API.
  await transaction({ reason: "همگام‌سازی تعطیلات تقویم" }, async (client) => {
    await client.query(
      `INSERT INTO holidays(holiday_date, title)
       SELECT so.work_date, 'تعطیلی تقویمی'
       FROM schedule_overrides so
       WHERE so.employee_id IS NULL AND so.is_holiday
         AND NOT EXISTS (
           SELECT 1 FROM holidays h WHERE h.holiday_date = so.work_date
         )`,
    );
  });
}

export type AuditContext = {
  actorId?: string;
  reason?: string;
  sessionId?: string;
  batchId?: string;
};
export async function transaction<T>(
  context: AuditContext,
  work: (client: pg.PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.actor_id',$1,true), set_config('app.reason',$2,true), set_config('app.session_id',$3,true), set_config('app.batch_id',$4,true)",
      [
        context.actorId ?? "local-admin",
        context.reason ?? "",
        context.sessionId ?? "local-session",
        context.batchId ?? "",
      ],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
