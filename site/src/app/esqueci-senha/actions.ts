"use server";

import { redirect } from "next/navigation";
import { accountByEmail, newToken, normalizeEmail, validEmail } from "@/lib/accounts";
import { db } from "@/lib/db";
import { sendPasswordReset } from "@/lib/mail";

export async function requestReset(form: FormData) {
  const email = normalizeEmail(form.get("email"));
  if (validEmail(email)) {
    const sql = await db();
    const account = await accountByEmail(sql, email);
    if (account) {
      const reset = newToken("kr_");
      await sql`INSERT INTO password_resets (token_hash, account_id, expires_at) VALUES (${reset.hash}, ${account.id}, now() + interval '1 hour')`;
      await sendPasswordReset(email, reset.token);
    }
  }
  redirect("/esqueci-senha?enviado=1");
}
