import Link from "next/link";
import { isPro, PLAN_LABELS, PLANS, type Account } from "@/lib/accounts";
import { formatDate, painelDb, SetupNotice, Shell } from "../shell";
import { createAccount } from "./actions";

export const dynamic = "force-dynamic";

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ q?: string; plano?: string; erro?: string }> }) {
  const { q = "", plano = "", erro } = await searchParams;
  const sql = await painelDb();
  if (typeof sql === "string") return <Shell active="clientes"><SetupNotice message={sql} /></Shell>;
  const search = `%${q.trim().toLowerCase()}%`;
  const rows = await sql<(Account & { free_used: number })[]>`
    SELECT a.*, (SELECT COALESCE(sum(f.clips), 0)::int FROM free_clips f WHERE f.device = a.device AND a.device <> '') AS free_used
    FROM accounts a
    WHERE (${q} = '' OR a.email LIKE ${search} OR a.name ILIKE ${search})
      AND (${plano} = '' OR a.plan = ${plano})
    ORDER BY a.created_at DESC LIMIT 200`;
  const [{ total, pro }] = await sql<{ total: number; pro: number }[]>`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE plan = 'lifetime' OR (plan IN ('monthly','yearly') AND plan_until > now() - interval '3 days'))::int AS pro
    FROM accounts`;
  return (
    <Shell active="clientes">
      <div className="stack">
        <div className="row spread">
          <h1 style={{ fontSize: 22 }}>Clientes</h1>
          <span className="muted small">{total} contas · {pro} pagantes</span>
        </div>
        <form className="row" method="get">
          <input name="q" defaultValue={q} placeholder="Buscar por e-mail ou nome" style={{ flex: 1, minWidth: 200 }} />
          <select name="plano" defaultValue={plano}>
            <option value="">Todos os planos</option>
            {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
          </select>
          <button type="submit">Filtrar</button>
        </form>
        {erro ? <p className="error">{erro}</p> : null}
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead><tr><th>E-mail</th><th>Plano</th><th>Até</th><th>PC</th><th>Cortes grátis</th><th>Último login</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/painel/clientes/${a.id}`}>{a.email}</Link>{a.status === "blocked" ? <span className="error small"> · bloqueada</span> : null}</td>
                  <td>{PLAN_LABELS[a.plan]}{a.plan !== "free" && !isPro(a) ? <span className="muted small"> (vencido)</span> : null}</td>
                  <td className="muted small">{a.plan_until ? formatDate(a.plan_until) : "—"}</td>
                  <td className="muted small">{a.device ? `${a.device.slice(0, 8)}…` : "—"}</td>
                  <td>{a.plan === "free" || !isPro(a) ? a.free_used : "—"}</td>
                  <td className="muted small">{a.last_login_at ? formatDate(a.last_login_at) : "nunca"}</td>
                </tr>
              ))}
              {rows.length === 0 ? <tr><td colSpan={6} className="muted">Nenhuma conta.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <form action={createAccount} className="card stack">
          <h2 style={{ fontSize: 16 }}>Criar conta manualmente</h2>
          <p className="muted small" style={{ margin: 0 }}>Para parceiros e testes. A pessoa define a senha no primeiro login no app.</p>
          <div className="row">
            <input type="email" name="email" placeholder="email@exemplo.com" required style={{ flex: 1, minWidth: 200 }} />
            <select name="plan" defaultValue="lifetime">
              {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
            </select>
            <input type="date" name="until" title="Válido até (mensal/anual)" />
            <button type="submit">Criar</button>
          </div>
        </form>
      </div>
    </Shell>
  );
}
