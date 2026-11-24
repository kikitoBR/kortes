import { accountByEmail, newToken, normalizeEmail, validEmail } from "@/lib/accounts";
import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";
import { sendPasswordReset } from "@/lib/mail";

export const dynamic = "force-dynamic";

/** Email a password reset link (always answers the same, so it never reveals who has an account). */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { email?: unknown };
    const email = normalizeEmail(body.email);
    if (validEmail(email)) {
      const sql = await db();
      const account = await accountByEmail(sql, email);
      if (account) {
        const reset = newToken("kr_");
        await sql`INSERT INTO password_resets (token_hash, account_id, expires_at) VALUES (${reset.hash}, ${account.id}, now() + interval '1 hour')`;
        await sendPasswordReset(email, reset.token);
      }
    }
    return json({ ok: true, detail: "Se existir uma conta com este e-mail, enviamos um link para criar uma nova senha." });
  } catch (error) {
    return errorResponse(error);
  }
}
