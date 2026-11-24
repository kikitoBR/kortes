import { AccountError, accountFromRequest, claimClip, sha256 } from "@/lib/accounts";
import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";
import { customerFrom } from "@/lib/license";

export const dynamic = "force-dynamic";

/** Before a video or live is cut: paid plans pass; the free plan spends one of its cuts. */
export async function POST(request: Request) {
  try {
    const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (bearer.startsWith("kl_")) return json(await legacyLicense(bearer, request));
    const { sql, account, device } = await accountFromRequest(request);
    const body = (await request.json().catch(() => ({}))) as { source?: unknown };
    const source = String(body.source ?? "").trim();
    if (!source) throw new AccountError("Vídeo sem identificação.");
    return json(await claimClip(sql, account, device, source));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Customers from before accounts typed a kl_ key by hand: it keeps cutting freely.
 * The key an account hands to the app is not one of those: it only works signed in,
 * so signing out and pasting it cannot skip the free plan.
 */
async function legacyLicense(key: string, request: Request) {
  await customerFrom(request).catch((error: Error & { status?: number }) => {
    throw new AccountError(error.message, error.status ?? 401, "license_invalid");
  });
  const sql = await db();
  const [owned] = await sql`SELECT 1 FROM accounts WHERE license_hash = ${sha256(key)}`;
  if (owned) throw new AccountError("Entre na sua conta do Kortes em Configurações.", 401, "signed_out");
  return { ok: true, pro: true, legacy: true, used: 0, limit: 0 };
}
