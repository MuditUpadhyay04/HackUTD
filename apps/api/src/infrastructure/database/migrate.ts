import { SQL } from "bun";

/** Serialize migration runners and reject changes to already applied migration files. */
export async function migrate(sql: SQL): Promise<void> {
  const migrations = [
    {version: "001_initial", url: new URL("../../../../../db/migrations/001_initial.sql", import.meta.url)},
    {version: "002_agent_learning", url: new URL("../../../../../db/migrations/002_agent_learning.sql", import.meta.url)},
    {version: "003_compact_datasets", url: new URL("../../../../../db/migrations/003_compact_datasets.sql", import.meta.url)},
  ];
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
  await compactDatasets(sql);
}

/** gzip-compressed JSON for the bulk parts of a dataset (frames, samples, source files). */
export const packJson = (value: unknown): Buffer => Buffer.from(Bun.gzipSync(Buffer.from(JSON.stringify(value))));
// copy into an ArrayBuffer-backed array: newer @types/bun reject a Uint8Array<ArrayBufferLike> here
export const unpackJson = (bytes: Uint8Array): any => JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(bytes))));

/** Move frames/samples/sourceFiles of rows written before 003 out of body. One row per transaction; safe to rerun. */
async function compactDatasets(sql: SQL): Promise<void> {
  const pending = await sql`SELECT id FROM datasets WHERE frames_gz IS NULL`;
  for (const { id } of pending) {
    await sql.begin(async tx => {
      const rows = await tx`SELECT body FROM datasets WHERE id=${id} AND frames_gz IS NULL FOR UPDATE`;
      if (!rows.length) return;
      const body = typeof rows[0].body === "string" ? JSON.parse(rows[0].body) : rows[0].body;
      const { samples, frames, sourceFiles, ...rest } = body;
      await tx`UPDATE datasets SET body=${JSON.stringify(rest)}::text::jsonb, frames_gz=${packJson(frames ?? [])}, samples_gz=${packJson(samples ?? [])}, sources_gz=${sourceFiles ? packJson(sourceFiles) : null} WHERE id=${id}`;
    });
    console.log(`[db] compacted dataset ${String(id).slice(0, 12)}`);
  }
}

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const sql = new SQL({ url: databaseUrl, max: 1 });
  try { await migrate(sql); } finally { await sql.close(); }
}

if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await migrateDatabase(process.env.DATABASE_URL);
}
