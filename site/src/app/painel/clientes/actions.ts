"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { accountByEmail, accountById, isPro, newToken, normalizeEmail, PLANS, setPlan, validEmail, type Plan } from "@/lib/accounts";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";
import { db } from "@/lib/db";
import { resetLicenseDevices, syncLicense } from "@/lib/license-admin";
import { resetUrl } from "@/lib/mail";

async function requireAdmin() {
  const store = await cookies();
  if (!(await isValidSession(store.get(SESSION_COOKIE)?.value))) redirect("/painel/entrar");
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
const done = (id: string, aviso: string) => {
  revalidatePath(`/painel/clientes/${id}`);
  revalidatePath("/painel/clientes");
  redirect(`/painel/clientes/${id}?aviso=${encodeURIComponent(aviso)}`);
};

export async function changePlan(form: FormData) {
  await requireAdmin();
  const id = text(form, "account");
  const plan = text(form, "plan") as Plan;
  if (!isId(id) || !PLANS.includes(plan)) return;
  const untilText = text(form, "until");
  const until = untilText ? new Date(`${untilText}T23:59:59-03:00`) : null;
  const sql = await db();
  await setPlan(sql, id, plan, until);
  done(id, "Plano atualizado.");
}

/** The account may sign in on another computer (the next sign-in binds it). */
export async function releaseDevice(form: FormData) {
  await requireAdmin();
  const id = text(form, "account");
  if (!isId(id)) return;
  const sql = await db();
  const account = await accountById(sql, id);
  if (!account) return;
  await sql`UPDATE accounts SET device = '', device_bound_at = NULL, updated_at = now() WHERE id = ${id}`;
  await sql`DELETE FROM account_sessions WHERE account_id = ${id}`;
  if (account.license_id) await resetLicenseDevices(account.license_id).catch(() => {});
  done(id, "Computador liberado: o próximo login prende a conta ao novo PC.");
}

export async function addFreeClips(form: FormData) {
  await requireAdmin();
  const id = text(form, "account");
  const device = text(form, "device");
  const amount = Math.max(-50, Math.min(50, Number(text(form, "amount")) || 0));
  if (!isId(id) || !device || !amount) return;
  const sql = await db();
  await sql`
    INSERT INTO free_devices (device, extra_clips) VALUES (${device}, ${amount})
    ON CONFLICT (device) DO UPDATE SET extra_clips = GREATEST(0, free_devices.extra_clips + ${amount})`;
  done(id, `${amount > 0 ? "+" : ""}${amount} ${Math.abs(amount) === 1 ? "corte grátis" : "cortes grátis"} neste PC.`);
}

export async function resetFreeClips(form: FormData) {
  await requireAdmin();
  const id = text(form, "account");
  const device = text(form, "device");
  if (!isId(id) || !device) return;
  const sql = await db();
  await sql`DELETE FROM free_clips WHERE device = ${device}`;
  done(id, "Cortes grátis deste PC zerados.");
}

export async function toggleBlock(form: FormData) {
  await requireAdmin();
  const id = text(form, "account");
  if (!isId(id)) return;
  const sql = await db();
  const account = await accountById(sql, id);
  if (!account) return;
  const status = account.status === "blocked" ? "active" : "blocked";
  await sql`UPDATE accounts SET status = ${status}, updated_at = now() WHERE id = ${id}`;
  if (status === "blocked") await sql`DELETE FROM account_sessions WHERE account_id = ${id}`;
  if (account.license_id) await syncLicense(account.license_id, { pro: isPro(account), blocked: status === "blocked" }).catch(() => {});
  done(id, status === "blocked" ? "Conta bloqueada." : "Conta desbloqueada.");
}

export async function makeResetLink(form: FormData) {
  await requireAdmin();
  const id = text(form, "account");
  if (!isId(id)) return;
  const sql = await db();
  const reset = newToken("kr_");
  await sql`INSERT INTO password_resets (token_hash, account_id, expires_at) VALUES (${reset.hash}, ${id}, now() + interval '24 hours')`;
  revalidatePath(`/painel/clientes/${id}`);
  redirect(`/painel/clientes/${id}?link=${encodeURIComponent(resetUrl(reset.token))}`);
}

export async function saveNotes(form: FormData) {
  await requireAdmin();
  const id = text(form, "account");
  if (!isId(id)) return;
  const sql = await db();
  await sql`UPDATE accounts SET notes = ${text(form, "notes").slice(0, 2000)}, updated_at = now() WHERE id = ${id}`;
  done(id, "Anotação salva.");
}

/** An account made by hand (a partner, a test), with no password yet: set at first sign-in. */
export async function createAccount(form: FormData) {
  await requireAdmin();
  const email = normalizeEmail(form.get("email"));
  const plan = text(form, "plan") as Plan;
  if (!validEmail(email) || !PLANS.includes(plan)) redirect("/painel/clientes?erro=Confira o e-mail e o plano.");
  const sql = await db();
  const existing = await accountByEmail(sql, email);
  if (existing) redirect(`/painel/clientes/${existing.id}?aviso=${encodeURIComponent("Essa conta já existia.")}`);
  const untilText = text(form, "until");
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO accounts (email, source, plan, plan_until) VALUES (${email}, 'painel', ${plan},
      ${plan === "monthly" || plan === "yearly" ? (untilText ? new Date(`${untilText}T23:59:59-03:00`) : null) : null})
    RETURNING id`;
  redirect(`/painel/clientes/${row.id}?aviso=${encodeURIComponent("Conta criada. A pessoa define a senha no primeiro login.")}`);
}
