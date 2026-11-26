import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { accountByEmail, isPro, normalizeEmail, setPlan, validEmail, type Plan } from "@/lib/accounts";
import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { syncLicense } from "@/lib/license-admin";

export const dynamic = "force-dynamic";

/**
 * Kirvano's webhook (help.kirvano.com, "Configurando Integração via Webhook"):
 * POST JSON with the token in the Security-Token header. Every call is stored first
 * (Painel → Pagamentos), then:
 *   SALE_APPROVED, SUBSCRIPTION_RENEWED  → Pro until plan.next_charge_date (lifetime for a one-time sale);
 *                                          the account is created from the buyer's e-mail if missing
 *   SUBSCRIPTION_PLAN_CHANGED            → the new plan, until plan.next_charge_date
 *   SALE_REFUNDED, SALE_CHARGEBACK, SALE_MED → back to free (unless it refunds another plan)
 *   SUBSCRIPTION_EXPIRED                 → Pro ends (3 days of grace, isPro)
 *   SUBSCRIPTION_CANCELED                → nothing: the paid period runs out by itself
 *   anything else (Pix/boleto generated, refused, abandoned cart) → logged only
 * Kirvano does not retry, but a manual resend repeats the same JSON: sale_id + event
 * (+ plan.charge_number) already applied is answered 200 and ignored. It waits 5 s at
 * most, so the license server is updated after the answer.
 *
 * Plans: one-time → lifetime; recurring → by plan.charge_frequency (ANNUALLY → yearly,
 * else monthly). KIRVANO_PLANS ({"<offer_id>": "monthly|yearly|lifetime"}) overrides.
 */

type Any = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
const RANK: Record<Plan, number> = { free: 0, monthly: 1, yearly: 2, lifetime: 3 };

function sameText(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function authorized(request: Request): boolean {
  const expected = process.env.KIRVANO_WEBHOOK_TOKEN;
  if (!expected) return false; // without the token nothing is granted (the call is still logged)
  const header = request.headers.get("security-token") ?? "";
  const query = new URL(request.url).searchParams.get("token") ?? "";
  return sameText(header, expected) || sameText(query, expected);
}

/** "2026-12-12 16:40:21" (Brasília) → Date. */
function brasilia(value: unknown): Date | null {
  const text = str(value);
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)) return null;
  const date = new Date(`${text.replace(" ", "T")}-03:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function planFrom(body: Any): Plan | null {
  const products = ((body.products as Any[]) ?? []).filter((p) => p && p.is_order_bump !== true);
  let map: Record<string, Plan> = {};
  try {
    map = JSON.parse(process.env.KIRVANO_PLANS || "{}");
  } catch {
    map = {};
  }
  for (const product of products) {
    const mapped = map[str(product.offer_id)] ?? map[str(product.id)];
    if (mapped) return mapped;
  }
  const frequency = str((body.plan as Any)?.charge_frequency).toUpperCase();
  if (body.type === "RECURRING" || frequency) return frequency === "ANNUALLY" ? "yearly" : "monthly";
  if (body.type === "ONE_TIME") return "lifetime";
  return null;
}

export async function POST(request: Request) {
  const raw = await request.text();
  let body: Any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }
  const sql = await db();
  const event = str(body.event).toUpperCase();
  const customer = (body.customer ?? {}) as Any;
  const email = normalizeEmail(customer.email);
  const plan = (body.plan ?? {}) as Any;
  const dedupe = body.sale_id ? `${str(body.sale_id)}:${event}:${str(plan.charge_number)}` : "";
  const ok = authorized(request);
  const status = ok ? "recebido" : process.env.KIRVANO_WEBHOOK_TOKEN ? "token inválido" : "KIRVANO_WEBHOOK_TOKEN não configurado: nada liberado";
  const [logged] = await sql<{ id: string }[]>`
    INSERT INTO payment_events (provider, event, email, result, payload, dedupe_key)
    VALUES ('kirvano', ${event}, ${email}, ${status}, ${sql.json(body as never)}, ${dedupe}) RETURNING id`;
  if (!ok) return json({ ok: false }, 401);

  const finish = async (result: string, applied = false) => {
    await sql`UPDATE payment_events SET result = ${result}, applied = ${applied} WHERE id = ${logged.id}`;
    return json({ ok: true, result });
  };
  if (dedupe) {
    const [done] = await sql`SELECT 1 FROM payment_events WHERE dedupe_key = ${dedupe} AND applied AND id <> ${logged.id}`;
    if (done) return finish("já processado (reenvio)");
  }
  if (!validEmail(email)) return finish(event === "ABANDONED_CART" ? "carrinho abandonado" : "sem e-mail do comprador");

  // The license server is told after Kirvano has its answer (5 s limit).
  const apply = async (accountId: string, next: Plan, until: Date | null) => {
    const row = await setPlan(sql, accountId, next, until, { syncLicense: false });
    if (row?.license_id) {
      after(() => syncLicense(row.license_id, { pro: isPro(row), blocked: row.status === "blocked" }).catch(() => {}));
    }
  };
  const day = (date: Date | null) => (date ? ` até ${date.toISOString().slice(0, 10)}` : "");

  let account = await accountByEmail(sql, email);

  if (event === "SALE_APPROVED" || event === "SUBSCRIPTION_RENEWED") {
    const bought = planFrom(body);
    if (!bought) return finish("pago, mas não reconheci o plano (veja KIRVANO_PLANS)");
    if (!account) {
      const [row] = await sql`
        INSERT INTO accounts (email, name, source) VALUES (${email}, ${str(customer.name).slice(0, 120)}, 'kirvano') RETURNING *`;
      account = row as never;
    }
    const current = account!;
    const active = isPro(current);
    // Paid until the next charge; a missing date (should not happen) gives the plan's length.
    const fallbackDays = bought === "yearly" ? 366 : 31;
    let until = bought === "lifetime" ? null : brasilia(plan.next_charge_date) ?? new Date(Date.now() + fallbackDays * 864e5);
    // Never a step down: lifetime stays lifetime, an active yearly keeps its label and its date.
    const effective: Plan = active && RANK[current.plan] > RANK[bought] ? current.plan : bought;
    if (effective !== "lifetime" && active && current.plan_until && until && new Date(current.plan_until) > until) {
      until = new Date(current.plan_until);
    }
    await apply(current.id, effective, effective === "lifetime" ? null : until);
    return finish(`plano ${effective}${effective === "lifetime" ? "" : day(until)}`, true);
  }

  if (!account) return finish("sem conta com este e-mail");

  if (event === "SUBSCRIPTION_PLAN_CHANGED") {
    if (account.plan === "lifetime") return finish("troca de plano: vitalício mantido", true);
    const next = planFrom(body) ?? account.plan;
    const until = brasilia(plan.next_charge_date) ?? (account.plan_until ? new Date(account.plan_until) : null);
    await apply(account.id, next, until);
    return finish(`plano trocado para ${next}${day(until)}`, true);
  }
  if (event === "SALE_REFUNDED" || event === "SALE_CHARGEBACK" || event === "SALE_MED") {
    // Takes back only what it paid for: refunding an old monthly keeps a later lifetime.
    const refunded = planFrom(body);
    if (refunded && refunded !== account.plan && isPro(account)) {
      return finish(`reembolso de ${refunded}: plano atual (${account.plan}) mantido`, true);
    }
    await apply(account.id, "free", null);
    return finish(event === "SALE_MED" ? "devolução do Pix: voltou ao grátis" : "reembolso/chargeback: voltou ao grátis", true);
  }
  if (event === "SUBSCRIPTION_EXPIRED") {
    if (account.plan === "lifetime") return finish("assinatura vencida: vitalício mantido", true);
    await apply(account.id, account.plan, new Date());
    return finish("assinatura vencida: Pro acaba em 3 dias se não pagar", true);
  }
  if (event === "SUBSCRIPTION_CANCELED") return finish("cancelada: vale até a data já paga", true);
  return finish("evento ignorado");
}
