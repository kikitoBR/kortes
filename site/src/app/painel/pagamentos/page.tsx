import { formatDate, painelDb, SetupNotice, Shell } from "../shell";

export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  const sql = await painelDb();
  if (typeof sql === "string") return <Shell active="pagamentos"><SetupNotice message={sql} /></Shell>;
  const rows = await sql<{ id: string; event: string; email: string; result: string; payload: unknown; created_at: Date }[]>`
    SELECT * FROM payment_events ORDER BY created_at DESC LIMIT 100`;
  return (
    <Shell active="pagamentos">
      <div className="stack">
        <h1 style={{ fontSize: 22 }}>Pagamentos (Kirvano)</h1>
        <p className="muted small" style={{ margin: 0 }}>Cada aviso recebido da Kirvano, com o que o site fez. Abra um para ver o que chegou.</p>
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead><tr><th>Quando</th><th>Evento</th><th>E-mail</th><th>Resultado</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted small">{formatDate(r.created_at)}</td>
                  <td>{r.event || "—"}</td>
                  <td>{r.email || "—"}</td>
                  <td>
                    {r.result}
                    <details><summary className="muted small">dados</summary><pre style={{ whiteSpace: "pre-wrap", fontSize: 11, maxWidth: 520 }}>{JSON.stringify(r.payload, null, 2).slice(0, 6000)}</pre></details>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? <tr><td colSpan={4} className="muted">Nenhum aviso ainda.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  );
}
