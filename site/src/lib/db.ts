import postgres from "postgres";

// One client per server instance. Neon/Vercel Postgres and a local Postgres both work.
const globalForDb = globalThis as unknown as { kortesSql?: postgres.Sql; kortesSchema?: Promise<void> };

function client(): postgres.Sql {
  if (!globalForDb.kortesSql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error("DATABASE_URL não configurada");
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    globalForDb.kortesSql = postgres(url, {
      max: 3,
      idle_timeout: 20,
      ssl: local ? false : "require",
      // Pooled (PgBouncer) connections do not keep prepared statements.
      prepare: false,
    });
  }
  return globalForDb.kortesSql;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS support_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_hash text NOT NULL,
  license_name text NOT NULL DEFAULT '',
  device text NOT NULL DEFAULT '',
  app_version text NOT NULL DEFAULT '',
  category text NOT NULL,
  subject text NOT NULL,
  contact text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_threads_license ON support_threads (license_hash, updated_at DESC);
CREATE INDEX IF NOT EXISTS support_threads_status ON support_threads (status, updated_at DESC);
CREATE TABLE IF NOT EXISTS support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  author text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_thread ON support_messages (thread_id, created_at);
CREATE TABLE IF NOT EXISTS announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text NOT NULL,
  action text NOT NULL DEFAULT '',
  href text NOT NULL DEFAULT '',
  is_published boolean NOT NULL DEFAULT false,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

/** The database, with its tables created on first use (no migration step to run). */
export async function db(): Promise<postgres.Sql> {
  const sql = client();
  globalForDb.kortesSchema ??= sql.unsafe(SCHEMA).then(() => undefined).catch((error) => {
    globalForDb.kortesSchema = undefined;
    throw error;
  });
  await globalForDb.kortesSchema;
  return sql;
}
