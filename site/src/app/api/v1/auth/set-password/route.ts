import { accountByEmail, AccountError, deviceFrom, hashPassword, signIn } from "@/lib/accounts";
import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";
import { checkPassword, credentials } from "../body";

export const dynamic = "force-dynamic";

/** First access of an account created by a purchase: its first password. */
export async function POST(request: Request) {
  try {
    const { email, password } = await credentials(request);
    checkPassword(password);
    const sql = await db();
    const account = await accountByEmail(sql, email);
    if (!account) throw new AccountError("Não existe conta com este e-mail.", 404, "no_account");
    if (account.password_hash) throw new AccountError("Esta conta já tem senha. Entre com ela.", 409, "has_password");
    await sql`UPDATE accounts SET password_hash = ${await hashPassword(password)}, updated_at = now() WHERE id = ${account.id}`;
    return json(await signIn(sql, { ...account, password_hash: "set" }, deviceFrom(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
