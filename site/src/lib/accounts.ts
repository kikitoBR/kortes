// Kortes Desktop accounts: email + password, one computer per account, a free plan
// of FREE_CLIPS cuts per computer (up to FREE_CLIPS_PER_VIDEO per video or live), and
// paid plans that come from Kirvano or from the panel.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type postgres from "postgres";

import { db } from "./db";
import { createLicense, rotateLicense, syncLicense } from "./license-admin";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const FREE_CLIPS = Number(process.env.FREE_CLIPS || 15);
export const FREE_CLIPS_PER_VIDEO = Number(process.env.FREE_CLIPS_PER_VIDEO || 5);
export const PLANS = ["free", "monthly", "yearly", "lifetime"] as const;
export type Plan = (typeof PLANS)[number];
export const PLAN_LABELS: Record<Plan, string> = { free: "Grátis", monthly: "Pro mensal", yearly: "Pro anual", lifetime: "Vitalício" };
const GRACE_MS = 3 * 24 * 3600 * 1000; // a late renewal keeps Pro for a few days

export type Account = {
  id: string;
  email: string;
  password_hash: string | null;
  name: string;
  plan: Plan;
  plan_until: Date | null;
  status: "active" | "blocked";
  device: string;
  license_id: string;
  source: string;
  notes: string;
  created_at: Date;
  last_login_at: Date | null;
};

/** An error the app shows as is. `code` lets it react (e.g. ask for a new password). */
export class AccountError extends Error {
  constructor(message: string, public status = 400, public code = "error") {
    super(message);
  }
}

export const normalizeEmail = (value: unknown) => String(value ?? "").trim().toLowerCase();
export const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 200;

export function isPro(account: Pick<Account, "plan" | "plan_until">): boolean {
  if (account.plan === "lifetime") return true;
  if (account.plan === "monthly" || account.plan === "yearly") {
    return Boolean(account.plan_until && new Date(account.plan_until).getTime() + GRACE_MS > Date.now());
  }
  return false;
}

// ---------------------------------------------------------------- passwords and tokens
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored?.startsWith("scrypt$")) return false;
  const [, saltHex, hashHex] = stored.split("$");
  const hash = await scrypt(password, Buffer.from(saltHex, "hex"), 32);
  const expected = Buffer.from(hashHex, "hex");
  return expected.length === hash.length && timingSafeEqual(expected, hash);
}

export function checkPassword(password: string) {
  if (password.length < 8) throw new AccountError("A senha precisa ter pelo menos 8 caracteres.");
  if (password.length > 200) throw new AccountError("Senha longa demais.");
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export function newToken(prefix: string) {
  const token = `${prefix}${randomBytes(32).toString("base64url")}`;
  return { token, hash: sha256(token) };
}

// ---------------------------------------------------------------- lookups
export async function accountByEmail(sql: postgres.Sql, email: string): Promise<Account | null> {
  const [row] = await sql<Account[]>`SELECT * FROM accounts WHERE email = ${email}`;
  return row ?? null;
}

export async function accountById(sql: postgres.Sql, id: string): Promise<Account | null> {
  const [row] = await sql<Account[]>`SELECT * FROM accounts WHERE id = ${id}`;
  return row ?? null;
}

/** The account behind the app's session token (Authorization: Bearer ks_...). */
export async function accountFromRequest(request: Request): Promise<{ sql: postgres.Sql; account: Account; device: string }> {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const device = deviceFrom(request);
  if (!token.startsWith("ks_")) throw new AccountError("Entre na sua conta do Kortes.", 401, "signed_out");
  const sql = await db();
  const [row] = await sql<(Account & { session_device: string })[]>`
    SELECT a.*, s.device AS session_device FROM account_sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ${sha256(token)}`;
  if (!row) throw new AccountError("Sua sessão expirou. Entre de novo.", 401, "signed_out");
  if (row.status === "blocked") throw new AccountError("Esta conta está bloqueada. Fale com o suporte.", 403, "blocked");
  if (row.device && device && row.device !== device) {
    throw new AccountError("Esta conta está ativa em outro computador.", 403, "other_device");
  }
  await sql`UPDATE account_sessions SET last_seen_at = now() WHERE token_hash = ${sha256(token)}`;
  return { sql, account: row, device: device || row.device };
}

export function deviceFrom(request: Request): string {
  return (request.headers.get("x-kortes-device") || "").trim().slice(0, 128);
}

// ---------------------------------------------------------------- free cuts (per computer)
// One free_clips row per video or live of the free plan, holding the cuts it was
// given (reserved up front, then trimmed to what it really made). free_devices.extra_clips
// holds the extra cuts given in the panel.
export async function freeUsage(sql: postgres.Sql, device: string) {
  if (!device) return { used: 0, limit: FREE_CLIPS, perVideo: FREE_CLIPS_PER_VIDEO };
  const [{ used }] = await sql<{ used: number }[]>`SELECT COALESCE(sum(clips), 0)::int AS used FROM free_clips WHERE device = ${device}`;
  const [extra] = await sql<{ extra_clips: number }[]>`SELECT extra_clips FROM free_devices WHERE device = ${device}`;
  return { used, limit: FREE_CLIPS + (extra?.extra_clips ?? 0), perVideo: FREE_CLIPS_PER_VIDEO };
}

/**
 * Reserve the free cuts of one video or live: up to FREE_CLIPS_PER_VIDEO, never more
 * than are left. The app then makes at most `clips` cuts and gives back what it did
 * not make (settleClips). The same video twice is refused. Paid accounts always get through.
 */
export async function claimClip(sql: postgres.Sql, account: Account, device: string, sourceKey: string) {
  if (isPro(account)) return { ok: true as const, pro: true, used: 0, limit: 0, clips: 0 };
  if (!device) throw new AccountError("Atualize o Kortes para a versão mais recente.", 400, "missing_device");
  const key = sourceKey.slice(0, 200);
  const usage = await freeUsage(sql, device);
  const [already] = await sql`SELECT 1 FROM free_clips WHERE device = ${device} AND source_key = ${key}`;
  if (already) {
    throw new AccountError(
      "No plano grátis cada vídeo ou live é cortado uma vez, e este já foi. Assine o Kortes Pro para cortes ilimitados.",
      402,
      "same_source",
    );
  }
  const left = usage.limit - usage.used;
  if (left <= 0) {
    throw new AccountError(
      `Seus ${usage.limit} cortes grátis acabaram. Assine o Kortes Pro para cortes ilimitados.`,
      402,
      "free_exhausted",
    );
  }
  const clips = Math.min(FREE_CLIPS_PER_VIDEO, left);
  await sql`INSERT INTO free_devices (device) VALUES (${device}) ON CONFLICT (device) DO NOTHING`;
  await sql`INSERT INTO free_clips (device, account_id, source_key, clips) VALUES (${device}, ${account.id}, ${key}, ${clips})`;
  return { ok: true as const, pro: false, used: usage.used + clips, limit: usage.limit, clips };
}

/**
 * The video or live is done: keep only the cuts it made, the rest go back to the
 * balance. None made gives the video back too (it can be tried again). Only for a
 * recent reservation, never an old one.
 */
export async function settleClips(sql: postgres.Sql, device: string, sourceKey: string, made: number) {
  const key = sourceKey.slice(0, 200);
  const count = Math.max(0, Math.floor(Number(made) || 0));
  if (count === 0) {
    await sql`DELETE FROM free_clips WHERE device = ${device} AND source_key = ${key} AND created_at > now() - interval '1 day'`;
    return;
  }
  // What it really made (a resumed video can make more than its first run kept),
  // never more than one video's share.
  await sql`
    UPDATE free_clips SET clips = ${Math.min(count, FREE_CLIPS_PER_VIDEO)}
    WHERE device = ${device} AND source_key = ${key} AND created_at > now() - interval '1 day'`;
}

// ---------------------------------------------------------------- sign-in
/** What the app shows about the account. */
export async function summary(sql: postgres.Sql, account: Account, device: string) {
  const pro = isPro(account);
  const free = await freeUsage(sql, device || account.device);
  return {
    email: account.email,
    name: account.name,
    plan: account.plan,
    planLabel: pro ? PLAN_LABELS[account.plan] : PLAN_LABELS.free,
    pro,
    planUntil: account.plan === "lifetime" ? null : account.plan_until,
    free: pro ? null : free,
  };
}

/**
 * Sign the app in on this computer: binds the account to the computer the first
 * time, refuses any other computer, and hands out a session and a fresh AI key
 * (the previous key stops working).
 */
export async function signIn(sql: postgres.Sql, account: Account, device: string) {
  if (!device) throw new AccountError("Atualize o Kortes para a versão mais recente.", 400, "missing_device");
  if (account.status === "blocked") throw new AccountError("Esta conta está bloqueada. Fale com o suporte.", 403, "blocked");
  if (account.device && account.device !== device) {
    throw new AccountError(
      "Esta conta já está ativa em outro computador. Para trocar de computador, fale com o suporte.",
      403,
      "other_device",
    );
  }
  const pro = isPro(account);
  let licenseKey: string;
  let licenseId = account.license_id;
  if (licenseId) {
    licenseKey = await rotateLicense(licenseId);
    await syncLicense(licenseId, { pro, blocked: false });
  } else {
    const created = await createLicense(account.email, pro);
    licenseId = created.id;
    licenseKey = created.key;
  }
  const session = newToken("ks_");
  await sql.begin(async (tx) => {
    await tx`
      UPDATE accounts SET device = ${device}, device_bound_at = COALESCE(device_bound_at, now()),
        license_id = ${licenseId}, license_hash = ${sha256(licenseKey)}, last_login_at = now(), updated_at = now()
      WHERE id = ${account.id}`;
    await tx`DELETE FROM account_sessions WHERE account_id = ${account.id}`;
    await tx`INSERT INTO account_sessions (token_hash, account_id, device) VALUES (${session.hash}, ${account.id}, ${device})`;
  });
  const fresh = (await accountById(sql, account.id))!;
  return { token: session.token, license: licenseKey, account: await summary(sql, fresh, device) };
}

/**
 * Apply a plan (Kirvano, panel) and keep the AI key's limits in step. The Kirvano
 * webhook passes syncLicense: false and updates the key after answering.
 */
export async function setPlan(
  sql: postgres.Sql,
  accountId: string,
  plan: Plan,
  until: Date | null,
  options: { syncLicense?: boolean } = {},
) {
  const [row] = await sql<Account[]>`
    UPDATE accounts SET plan = ${plan}, plan_until = ${plan === "lifetime" || plan === "free" ? null : until}, updated_at = now()
    WHERE id = ${accountId} RETURNING *`;
  if (row?.license_id && options.syncLicense !== false) {
    await syncLicense(row.license_id, { pro: isPro(row), blocked: row.status === "blocked" }).catch(() => {});
  }
  return row;
}
