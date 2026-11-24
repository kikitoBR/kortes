"use server";

import { redirect } from "next/navigation";
import { hashPassword, sha256 } from "@/lib/accounts";
import { db } from "@/lib/db";

const back = (token: string, erro: string) =>
  redirect(`/redefinir-senha?token=${encodeURIComponent(token)}&erro=${encodeURIComponent(erro)}`);

export async function resetPassword(form: FormData) {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  if (password.length < 8) back(token, "A senha precisa ter pelo menos 8 caracteres.");
  if (password !== String(form.get("confirm") ?? "")) back(token, "As senhas não são iguais.");
  const sql = await db();
  const [reset] = await sql<{ account_id: string }[]>`
    UPDATE password_resets SET used_at = now()
    WHERE token_hash = ${sha256(token)} AND used_at IS NULL AND expires_at > now()
    RETURNING account_id`;
  if (!reset) back(token, "Este link expirou ou já foi usado. Peça um novo no Kortes.");
  await sql`UPDATE accounts SET password_hash = ${await hashPassword(password)}, updated_at = now() WHERE id = ${reset.account_id}`;
  await sql`DELETE FROM account_sessions WHERE account_id = ${reset.account_id}`;
  redirect("/redefinir-senha?ok=1");
}
