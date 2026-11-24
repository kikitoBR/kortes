import { accountByEmail, isPro, normalizeEmail, setPlan, validEmail, type Plan } from "@/lib/accounts";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Kirvano's webhook: sales and subscriptions turn into plans. Every call is stored
 * (Painel → Pagamentos) before anything else, so a payload we read wrong can be
 * fixed and replayed. Configure in Kirvano: URL https://kortes.com.br/api/kirvano
 * and the token in KIRVANO_WEBHOOK_TOKEN.
 *
 * Plans: KIRVANO_PLANS maps offer/product ids to plans, e.g.
 *   {"abc123":"monthly","def456":"yearly","ghi789":"lifetime"}
 * without it the product/offer name decides (mensal, anual, vitalício).
 */

type Any = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

function authorized(request: Request, body: Any): boolean {
  const expected = process.env.KIRVANO_WEBHOOK_TOKEN;
  if (!expected) return false; // without the token nothing is granted (the call is still logged)
  const url = new URL(request.url);
  const candidates = [
    url.searchParams.get("token"),
    str(body.token),
    str(body.security_token),
    ...[...request.headers.entries()].map(([, value]) => value.replace(/^Bearer\s+/i, "")),
  ];
  return candidates.some((value) => value === expected);
}

function planFrom(body: Any): Plan | null {
  const products = ([] as Any[]).concat((body.products as Any[]) ?? [], body.product ? [body.product as Any] : [], body.offer ? [body.offer as Any] : []);
  let map: Record<string, Plan> = {};
  try {
    map = JSON.parse(process.env.KIRVANO_PLANS || "{}");
  } catch {
    map = {};
  }
  const ids = products.flatMap((p) => [str(p.offer_id), str(p.id), str(p.product_id), str((p.offer as Any)?.id)]).filter(Boolean);
  for (const id of ids) if (map[id]) return map[id];
  const names = [...products.flatMap((p) => [str(p.name), str(p.offer_name), str((p.offer as Any)?.name)]), str((body.plan as Any)?.name), str(body.offer_name)]
    .join(" ")
    .toLowerCase();
  if (/vital/.test(names)) return "lifetime";
  if (/anual|annual|year|12 ?mes/.test(names)) return "yearly";
  if (/mensal|monthly|month|1 ?m[eê]s/.test(names)) return "monthly";
  const recurrence = str((body.plan as Any)?.charge_frequency || (body.plan as Any)?.recurrence || body.recurrence).toLowerCase();
  if (/year|anual/.test(recurrence)) return "yearly";
  if (/month|mensal/.test(recurrence)) return "monthly";
  return null;
}

const DAYS: Record<Plan, number> = { free: 0, monthly: 31, yearly: 366, lifetime: 0 };
const RANK: Record<Plan, number> = { free: 0, monthly: 1, yearly: 2, lifetime: 3 };

export async function POST(request: Request) {
  const raw = await request.text();
  let body: Any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }
  const sql = await db();
  const event = (str(body.event) || str(body.type) || str(body.status)).toUpperCase();
  const customer = (body.customer ?? body.buyer ?? {}) as Any;
  const email = normalizeEmail(customer.email ?? body.email);
  const ok = authorized(request, body);
  const [logged] = await sql<{ id: string }[]>`
    INSERT INTO payment_events (provider, event, email, result, payload)
    VALUES ('kirvano', ${event}, ${email}, ${ok ? "recebido" : process.env.KIRVANO_WEBHOOK_TOKEN ? "token inválido" : "KIRVANO_WEBHOOK_TOKEN não configurado: nada liberado"}, ${sql.json(body as never)}) RETURNING id`;
  if (!ok) return json({ ok: false }, 401);

  const finish = async (result: string) => {
    await sql`UPDATE payment_events SET result = ${result} WHERE id = ${logged.id}`;
    return json({ ok: true, result });
  };
  if (!validEmail(email)) return finish("sem e-mail do comprador");

  const grant = /APPROVED|PAID|RENEW|ACTIVAT|COMPLETE/.test(event) && !/REFUS|DECLIN/.test(event);
  const revoke = /REFUND|CHARGEBACK|ESTORN|REEMBOLS/.test(event);
  const expire = /EXPIRED|OVERDUE|LATE/.test(event);
  const cancel = /CANCEL/.test(event);

  let account = await accountByEmail(sql, email);
  if (grant) {
    const plan = planFrom(body);
    if (!plan) return finish("pago, mas não reconheci o plano (configure KIRVANO_PLANS)");
    if (!account) {
      const [row] = await sql`
        INSERT INTO accounts (email, name, source) VALUES (${email}, ${str(customer.name).slice(0, 120)}, 'kirvano') RETURNING *`;
      account = row as never;
    }
    // Paid time still left (any plan) is kept: the new payment adds to it.
    const current = account!;
    const active = isPro(current);
    const from = active && current.plan_until && new Date(current.plan_until) > new Date() ? new Date(current.plan_until) : new Date();
    const until = plan === "lifetime" ? null : new Date(from.getTime() + DAYS[plan] * 24 * 3600 * 1000);
    // Never a step down: lifetime stays lifetime, an active yearly is not relabelled monthly.
    const effective: Plan = active && RANK[current.plan] > RANK[plan] ? current.plan : plan;
    await setPlan(sql, account!.id, effective, effective === "lifetime" ? null : until);
    return finish(`plano ${effective}${until && effective !== "lifetime" ? ` até ${until.toISOString().slice(0, 10)}` : ""}`);
  }
  if (!account) return finish("sem conta com este e-mail");
  if (revoke) {
    // A refund takes back only what it paid for: refunding an old monthly keeps a later lifetime.
    const refunded = planFrom(body);
    if (refunded && refunded !== account.plan && isPro(account)) {
      return finish(`reembolso de ${refunded}: plano atual (${account.plan}) mantido`);
    }
    await setPlan(sql, account.id, "free", null);
    return finish("reembolso/chargeback: voltou ao grátis");
  }
  if (expire) {
    if (account.plan !== "lifetime") await setPlan(sql, account.id, account.plan, new Date());
    return finish("assinatura vencida");
  }
  if (cancel) return finish("cancelada: vale até a data já paga");
  return finish("evento ignorado");
}
