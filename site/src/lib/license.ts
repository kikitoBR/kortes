// Kortes Desktop calls carry the customer's license (Authorization: Bearer kl_...) and
// the computer's id (x-kortes-device). The license server (gemini-web2api) says whether
// the license is valid and whose it is; only its SHA-256 is stored here.

import { createHash } from "node:crypto";

export type Customer = { hash: string; name: string; device: string; version: string };

const cache = new Map<string, { name: string; until: number }>();
const CACHE_MS = 5 * 60 * 1000;

export class LicenseError extends Error {
  constructor(message: string, public status = 401) {
    super(message);
  }
}

export async function customerFrom(request: Request): Promise<Customer> {
  const auth = request.headers.get("authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  const device = (request.headers.get("x-kortes-device") || "").slice(0, 64);
  const version = (request.headers.get("x-kortes-version") || "").slice(0, 32);
  if (!key.startsWith("kl_")) throw new LicenseError("Licença ausente. Ative o Kortes em Configurações.");
  const hash = createHash("sha256").update(key).digest("hex");

  const cached = cache.get(`${hash}:${device}`);
  if (cached && cached.until > Date.now()) return { hash, name: cached.name, device, version };

  const base = (process.env.LICENSE_SERVER_URL || "https://gemini.kikito.site/v1").replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}/license`, {
      headers: { Authorization: `Bearer ${key}`, ...(device ? { "x-kortes-device": device } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new LicenseError("Não deu para conferir a licença agora. Tente de novo em instantes.", 503);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new LicenseError(body?.error?.message || "Licença inválida.", 401);
  }
  const info = (await response.json().catch(() => ({}))) as { name?: string };
  const name = String(info.name || "").slice(0, 120);
  cache.set(`${hash}:${device}`, { name, until: Date.now() + CACHE_MS });
  return { hash, name, device, version };
}
