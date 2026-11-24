import { accountByEmail, AccountError, deviceFrom, signIn, verifyPassword } from "@/lib/accounts";
import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";
import { credentials } from "../body";

export const dynamic = "force-dynamic";

/** Sign in from Kortes Desktop (email + password, this computer's id in x-kortes-device). */
export async function POST(request: Request) {
  try {
    const { email, password } = await credentials(request);
    const sql = await db();
    const account = await accountByEmail(sql, email);
    if (!account) throw new AccountError("Não existe conta com este e-mail. Crie uma conta grátis.", 404, "no_account");
    // Bought on Kirvano: the account exists without a password until the first sign-in.
    if (!account.password_hash) {
      throw new AccountError("Primeiro acesso: crie uma senha para esta conta.", 409, "needs_password");
    }
    if (!(await verifyPassword(password, account.password_hash))) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      throw new AccountError("E-mail ou senha incorretos.", 401, "wrong_password");
    }
    return json(await signIn(sql, account, deviceFrom(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
