import { accountByEmail, AccountError, normalizeEmail, validEmail } from "@/lib/accounts";
import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * The app's sign-in starts with the e-mail alone; this says which step comes next:
 *   "password" → the account has a password: ask for it
 *   "first"    → bought on Kirvano, no password yet: create one
 *   "new"      → no account: create a free one
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { email?: unknown };
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) throw new AccountError("Digite um e-mail válido.");
    const account = await accountByEmail(await db(), email);
    const next = !account ? "new" : account.password_hash ? "password" : "first";
    return json({ next });
  } catch (error) {
    return errorResponse(error);
  }
}
