import { sha256 } from "@/lib/accounts";
import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** End the app's session. The computer stays tied to the account. */
export async function POST(request: Request) {
  try {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (token.startsWith("ks_")) {
      const sql = await db();
      await sql`DELETE FROM account_sessions WHERE token_hash = ${sha256(token)}`;
    }
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
