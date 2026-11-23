import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";
import { customerFrom } from "@/lib/license";
import { notifyNewMessage } from "@/lib/notify";
import { CATEGORIES, isCategory, MESSAGE_MAX, subjectFrom } from "@/lib/support";
import { cleanBody, threadsFor, underRateLimit } from "./thread";

export const dynamic = "force-dynamic";

/** The customer's conversations (license in Authorization). */
export async function GET(request: Request) {
  try {
    const customer = await customerFrom(request);
    const sql = await db();
    return json({ threads: await threadsFor(sql, customer.hash) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** A new conversation: {category, message, contact?}. */
export async function POST(request: Request) {
  try {
    const customer = await customerFrom(request);
    const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = cleanBody(input?.message);
    if (!isCategory(input?.category)) return json({ detail: "Escolha o tipo da mensagem." }, 422);
    if (!body) return json({ detail: `Escreva a mensagem (até ${MESSAGE_MAX} caracteres).` }, 422);
    const contact = typeof input?.contact === "string" ? input.contact.trim().slice(0, 200) : "";

    const sql = await db();
    if (!(await underRateLimit(sql, customer.hash))) {
      return json({ detail: "Muitas mensagens em pouco tempo. Tente de novo daqui a pouco." }, 429);
    }
    const [thread] = await sql`
      INSERT INTO support_threads (license_hash, license_name, device, app_version, category, subject, contact)
      VALUES (${customer.hash}, ${customer.name}, ${customer.device}, ${customer.version},
              ${input!.category as string}, ${subjectFrom(body)}, ${contact})
      RETURNING id`;
    await sql`INSERT INTO support_messages (thread_id, author, body) VALUES (${thread.id}, 'customer', ${body})`;
    await notifyNewMessage({
      customer: customer.name,
      category: CATEGORIES[input!.category as keyof typeof CATEGORIES],
      body,
      threadId: thread.id as string,
      isNew: true,
    });
    return json({ threads: await threadsFor(sql, customer.hash), id: thread.id }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
