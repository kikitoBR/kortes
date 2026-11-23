import Link from "next/link";
import { db } from "@/lib/db";
import { CATEGORIES, STATUS_LABELS } from "@/lib/support";
import { formatDate, Shell } from "./shell";

const FILTERS = [
  { key: "open", label: "Aguardando você" },
  { key: "answered", label: "Respondidas" },
  { key: "closed", label: "Encerradas" },
  { key: "all", label: "Todas" },
] as const;

export default async function Mensagens({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status: requested } = await searchParams;
  const status = FILTERS.some((f) => f.key === requested) ? requested! : "open";
  const sql = await db();
  const threads = await sql`
    SELECT t.id, t.license_name, t.category, t.subject, t.status, t.updated_at,
      (SELECT count(*)::int FROM support_messages m WHERE m.thread_id = t.id) AS messages
    FROM support_threads t
    WHERE ${status === "all"} OR t.status = ${status}
    ORDER BY t.updated_at DESC LIMIT 200`;
  const [counts] = await sql`SELECT count(*) FILTER (WHERE status = 'open')::int AS open FROM support_threads`;

  return (
    <Shell active="mensagens">
      <div className="pagehead">
        <div>
          <h1>Mensagens</h1>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            Suporte e feedback enviados pelo app. {counts.open ? `${counts.open} aguardando resposta.` : "Nada pendente."}
          </p>
        </div>
        <nav className="filters" aria-label="Filtrar">
          {FILTERS.map((f) => (
            <Link key={f.key} href={f.key === "open" ? "/painel" : `/painel?status=${f.key}`} aria-current={status === f.key ? "page" : undefined}>
              {f.label}
            </Link>
          ))}
        </nav>
      </div>
      {threads.length === 0 ? (
        <div className="card muted">Nenhuma mensagem aqui.</div>
      ) : (
        <ul className="list">
          {threads.map((t) => (
            <li key={t.id as string}>
              <Link className="item" href={`/painel/mensagens/${t.id}`}>
                <div className="row spread">
                  <strong>{t.subject as string}</strong>
                  <span className={`badge ${t.status}`}>{STATUS_LABELS[t.status as string] ?? (t.status as string)}</span>
                </div>
                <div className="row small muted">
                  <span>{(t.license_name as string) || "Licença sem nome"}</span>
                  <span>·</span>
                  <span>{CATEGORIES[t.category as keyof typeof CATEGORIES] ?? (t.category as string)}</span>
                  <span>·</span>
                  <span>{t.messages as number} mensage{(t.messages as number) === 1 ? "m" : "ns"}</span>
                  <span>·</span>
                  <span>{formatDate(t.updated_at as Date)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
