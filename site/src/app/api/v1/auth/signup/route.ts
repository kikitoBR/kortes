import { accountByEmail, AccountError, deviceFrom, hashPassword, signIn } from "@/lib/accounts";
import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";
import { checkPassword, credentials } from "../body";

export const dynamic = "force-dynamic";

/** A free account, created from the app. */
export async function POST(request: Request) {
  try {
    const { email, password, name } = await credentials(request);
    checkPassword(password);
    const sql = await db();
    if (await accountByEmail(sql, email)) {
      throw new AccountError("Já existe uma conta com este e-mail. Entre com a sua senha.", 409, "exists");
    }
    const [account] = await sql`
      INSERT INTO accounts (email, password_hash, name, source) VALUES (${email}, ${await hashPassword(password)}, ${name}, 'app')
      RETURNING *`;
    return json(await signIn(sql, account as never, deviceFrom(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
