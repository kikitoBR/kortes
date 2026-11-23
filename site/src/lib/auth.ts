// The /painel login: one password (ADMIN_PASSWORD), a signed cookie for 7 days.
// Web Crypto only, so the middleware (edge) and the server share it.

export const SESSION_COOKIE = "kortes_painel";
export const SESSION_DAYS = 7;

function secret(): string {
  const value = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
  return value ? `kortes-painel:${value}` : "";
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionValue(): Promise<string> {
  const expires = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  return `${expires}.${await hmac(String(expires))}`;
}

export async function isValidSession(value: string | undefined): Promise<boolean> {
  if (!value || !secret()) return false;
  const [expires, signature] = value.split(".");
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  return sameText(signature, await hmac(expires));
}

export async function passwordMatches(input: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) return false;
  // Compare digests, so the time taken does not depend on the length.
  const [a, b] = await Promise.all([hmac(`pw:${input}`), hmac(`pw:${expected}`)]);
  return sameText(a, b);
}
