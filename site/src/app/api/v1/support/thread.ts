import type postgres from "postgres";
import { MESSAGE_MAX } from "@/lib/support";

/** A customer's threads with their messages (what the app's support panel shows). */
export async function threadsFor(sql: postgres.Sql, licenseHash: string) {
  const threads = await sql`
    SELECT id, category, subject, status, created_at, updated_at
    FROM support_threads WHERE license_hash = ${licenseHash}
    ORDER BY updated_at DESC LIMIT 50`;
  if (threads.length === 0) return [];
  const ids = threads.map((t) => t.id as string);
  const messages = await sql`
    SELECT id, thread_id, author, body, created_at FROM support_messages
    WHERE thread_id = ANY(${ids}::uuid[]) ORDER BY created_at`;
  return threads.map((t) => ({
    id: t.id as string,
    category: t.category as string,
    subject: t.subject as string,
    status: t.status as string,
    createdAt: (t.created_at as Date).toISOString(),
    updatedAt: (t.updated_at as Date).toISOString(),
    messages: messages
      .filter((m) => m.thread_id === t.id)
      .map((m) => ({
        id: m.id as string,
        author: m.author as string,
        body: m.body as string,
        createdAt: (m.created_at as Date).toISOString(),
      })),
  }));
}

export function cleanBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const body = value.replace(/\r\n/g, "\n").trim();
  return body && body.length <= MESSAGE_MAX ? body : null;
}

/** At most 20 customer messages per license per hour. */
export async function underRateLimit(sql: postgres.Sql, licenseHash: string): Promise<boolean> {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM support_messages m
    JOIN support_threads t ON t.id = m.thread_id
    WHERE t.license_hash = ${licenseHash} AND m.author = 'customer'
      AND m.created_at > now() - interval '1 hour'`;
  return (row?.n as number) < 20;
}
