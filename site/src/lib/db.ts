import postgres from "postgres";

// One client per server instance. Neon/Vercel Postgres and a local Postgres both work.
const globalForDb = globalThis as unknown as { kortesSql?: postgres.Sql; kortesSchema?: Promise<void> };

/** A setup problem the panel shows as is (no secrets in the message). */
export class SetupProblem extends Error {}

/** DATABASE_URL, or what the Vercel/Neon integration created (maybe with a custom prefix). */
export function databaseUrl(): string | undefined {
  const env = process.env;
  const direct = env.DATABASE_URL || env.POSTGRES_URL;
  if (direct) return direct;
  const key = Object.keys(env).find(
    (name) => /_URL$/.test(name) && !/UNPOOLED|NON_POOLING/.test(name) && /^postgres(ql)?:\/\//.test(env[name] || ""),
  );
  return key ? env[key] : undefined;
}

/** What went wrong with the database, in words that are safe to show. */
export function describeDbError(error: unknown): string {
  if (error instanceof SetupProblem) return error.message;
  const e = error as { code?: string; message?: string };
  const code = e?.code ? ` (${e.code})` : "";
  if (e?.code === "28P01") return "O banco recusou o usuário/senha do DATABASE_URL.";
  if (e?.code === "ENOTFOUND" || e?.code === "ECONNREFUSED" || e?.code === "ETIMEDOUT") return `Não deu para conectar ao banco${code}. Confira o DATABASE_URL.`;
  return `Erro no banco${code}: ${String(e?.message || error).replace(/postgres(ql)?:\/\/\S+/g, "[url]").slice(0, 300)}`;
}

function client(): postgres.Sql {
  if (!globalForDb.kortesSql) {
    const url = databaseUrl();
    if (!url) throw new SetupProblem("Nenhum banco configurado: conecte um Postgres (Neon) ao projeto na Vercel, em Storage, ou defina DATABASE_URL.");
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
-- Accounts (Kortes Desktop sign-in). One computer per account; the free cuts are
-- counted per computer, so a second free account on the same PC gets nothing new.
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text,
  name text NOT NULL DEFAULT '',
  plan text NOT NULL DEFAULT 'free',
  plan_until timestamptz,
  status text NOT NULL DEFAULT 'active',
  device text NOT NULL DEFAULT '',
  device_bound_at timestamptz,
  license_id text NOT NULL DEFAULT '',
  license_hash text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'app',
  notes text NOT NULL DEFAULT '',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_sessions_account ON account_sessions (account_id);
CREATE TABLE IF NOT EXISTS free_devices (
  device text PRIMARY KEY,
  extra_clips integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS free_clips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device text NOT NULL,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  source_key text NOT NULL,
  clips integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device, source_key)
);
ALTER TABLE free_clips ADD COLUMN IF NOT EXISTS clips integer NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS license_hash text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE IF NOT EXISTS payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  result text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
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
