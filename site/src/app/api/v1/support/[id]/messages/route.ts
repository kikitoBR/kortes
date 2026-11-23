import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";
import { customerFrom } from "@/lib/license";
import { notifyNewMessage } from "@/lib/notify";
import { CATEGORIES, MESSAGE_MAX } from "@/lib/support";
import { cleanBody, threadsFor, underRateLimit } from "../../thread";

export const dynamic = "force-dynamic";

/** The customer answers in one of their conversations: {message}. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const customer = await customerFrom(request);
    const { id } = await params;
    const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = cleanBody(input?.message);
    if (!body) return json({ detail: `Escreva a mensagem (até ${MESSAGE_MAX} caracteres).` }, 422);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ detail: "Conversa não encontrada." }, 404);

    const sql = await db();
    const [thread] = await sql`
      SELECT id, category FROM support_threads WHERE id = ${id} AND license_hash = ${customer.hash}`;
    if (!thread) return json({ detail: "Conversa não encontrada." }, 404);
    if (!(await underRateLimit(sql, customer.hash))) {
      return json({ detail: "Muitas mensagens em pouco tempo. Tente de novo daqui a pouco." }, 429);
    }
    await sql`INSERT INTO support_messages (thread_id, author, body) VALUES (${id}, 'customer', ${body})`;
    await sql`
      UPDATE support_threads SET status = 'open', updated_at = now(),
        app_version = COALESCE(NULLIF(${customer.version}, ''), app_version)
      WHERE id = ${id}`;
    await notifyNewMessage({
      customer: customer.name,
      category: CATEGORIES[thread.category as keyof typeof CATEGORIES] ?? String(thread.category),
      body,
      threadId: id,
      isNew: false,
    });
    return json({ threads: await threadsFor(sql, customer.hash) });
  } catch (error) {
    return errorResponse(error);
  }
}
