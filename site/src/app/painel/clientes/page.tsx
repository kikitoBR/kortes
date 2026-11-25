import Link from "next/link";
import { isPro, PLAN_LABELS, PLANS, type Account } from "@/lib/accounts";
import { formatDate, painelDb, SetupNotice, Shell } from "../shell";
import { createAccount } from "./actions";
import { Icon } from "../../brand";

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
  const free = total - pro;
  return (
    <Shell active="clientes">
      <div className="pagehead">
        <div>
          <h1>Clientes</h1>
          <p>Contas do app: plano, computador e cortes grátis. Clique em uma para gerenciar.</p>
        </div>
      </div>
      <div className="stats">
        <div className="stat"><b>{total}</b><span>contas</span></div>
        <div className="stat accent"><b>{pro}</b><span>pagantes</span></div>
        <div className="stat"><b>{free}</b><span>no plano grátis</span></div>
      </div>
      <form className="toolbar" method="get">
        <span className="search">
          <Icon name="search" />
          <input type="search" name="q" defaultValue={q} placeholder="Buscar por e-mail ou nome" />
        </span>
        <select name="plano" defaultValue={plano} aria-label="Plano">
          <option value="">Todos os planos</option>
          {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
        </select>
        <button type="submit" className="ghost">Filtrar</button>
      </form>
      {erro ? <p className="alert error" style={{ marginBottom: 14 }}>{erro}</p> : null}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Conta</th><th>Plano</th><th>Até</th><th>PC</th><th>Cortes grátis</th><th>Último login</th></tr></thead>
          <tbody>
            {rows.map((a) => {
              const paid = isPro(a);
              const tone = a.status === "blocked" ? "blocked" : paid ? "pro" : a.plan !== "free" ? "expired" : "free";
              const label = a.status === "blocked" ? "Bloqueada" : a.plan !== "free" && !paid ? `${PLAN_LABELS[a.plan]} vencido` : PLAN_LABELS[a.plan];
              return (
                <tr key={a.id}>
                  <td>
                    <Link href={`/painel/clientes/${a.id}`}>{a.email}</Link>
                    {a.name ? <div className="muted small">{a.name}</div> : null}
                  </td>
                  <td><span className={`badge ${tone}`}>{label}</span></td>
                  <td className="muted small">{a.plan === "lifetime" ? "Sempre" : a.plan_until ? formatDate(a.plan_until) : "—"}</td>
                  <td className="muted small">{a.device ? <code>{a.device.slice(0, 8)}</code> : "—"}</td>
                  <td>{paid ? <span className="muted">—</span> : a.free_used}</td>
                  <td className="muted small">{a.last_login_at ? formatDate(a.last_login_at) : "nunca"}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? <tr><td colSpan={6} className="empty">Nenhuma conta encontrada.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <form action={createAccount} className="card stack" style={{ marginTop: 18 }}>
        <div>
          <h2 className="card-title"><Icon name="plus" /> Criar conta manualmente</h2>
          <p className="muted small" style={{ marginTop: 4 }}>Para parceiros e testes. A pessoa cria a senha no primeiro login no app.</p>
        </div>
        <div className="row">
          <input type="email" name="email" placeholder="email@exemplo.com" required style={{ flex: "2 1 220px", width: "auto" }} />
          <select name="plan" defaultValue="lifetime" style={{ flex: "1 1 150px", width: "auto" }}>
            {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
          </select>
          <input type="date" name="until" title="Válido até (mensal/anual)" style={{ flex: "1 1 150px", width: "auto" }} />
          <button type="submit">Criar conta</button>
        </div>
      </form>
    </Shell>
  );
}
