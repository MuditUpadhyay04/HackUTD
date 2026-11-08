import { SQL } from "bun";

/** Serialize migration runners and reject changes to already applied migration files. */
export async function migrate(sql: SQL): Promise<void> {
  const migrations = [{version: "001_initial", url: new URL("../../../../../db/migrations/001_initial.sql", import.meta.url)}];
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(774327651094)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const migration of migrations) {
      const text = await Bun.file(migration.url).text();
      const checksum = new Bun.CryptoHasher("sha256").update(text).digest("hex");
      const rows = await tx`SELECT checksum FROM schema_migrations WHERE version=${migration.version}`;
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error(`Migration checksum mismatch: ${migration.version}`);
        continue;
      }
      // SQL is bundled migration text, never a user-provided value.
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations(version,checksum) VALUES (${migration.version},${checksum})`;
    }
    const available = await tx`SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'`;
    const state = available.length ? "enabled" : "unavailable";
    if (state === "enabled") {
      await tx`SELECT create_hypertable('telemetry_samples', 'event_time', if_not_exists => TRUE, migrate_data => TRUE)`;
      await tx`SELECT create_hypertable('inference_results', 'event_time', if_not_exists => TRUE, migrate_data => TRUE)`;
    }
    await tx`INSERT INTO storage_metadata (key,value) VALUES ('timescaledb',${state}) ON CONFLICT (key) DO UPDATE SET value=excluded.value`;
  });
}

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const sql = new SQL({ url: databaseUrl, max: 1 });
  try { await migrate(sql); } finally { await sql.close(); }
}

if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await migrateDatabase(process.env.DATABASE_URL);
}
