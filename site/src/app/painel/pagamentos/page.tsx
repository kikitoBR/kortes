import { formatDate, painelDb, SetupNotice, Shell } from "../shell";

export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  const sql = await painelDb();
  if (typeof sql === "string") return <Shell active="pagamentos"><SetupNotice message={sql} /></Shell>;
  const rows = await sql<{ id: string; event: string; email: string; result: string; payload: unknown; created_at: Date }[]>`
    SELECT * FROM payment_events ORDER BY created_at DESC LIMIT 100`;
  const tone = (result: string) =>
    /^plano|cancelada|assinatura vencida|mantido/.test(result) ? "ok" : /voltou ao grátis/.test(result) ? "warn" : /token|não reconheci|sem e-mail|sem conta|não configurado/.test(result) ? "danger" : "";
  return (
    <Shell active="pagamentos">
      <div className="pagehead">
        <div>
          <h1>Pagamentos</h1>
          <p>Cada aviso da Kirvano e o que o site fez com ele. Abra “dados” para ver o que chegou.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Quando</th><th>Evento</th><th>E-mail</th><th>Resultado</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="muted small" style={{ whiteSpace: "nowrap" }}>{formatDate(r.created_at)}</td>
                <td><code>{r.event || "—"}</code></td>
                <td>{r.email || "—"}</td>
                <td>
                  <span className={`badge ${tone(r.result)}`}>{r.result}</span>
                  <details><summary className="muted small" style={{ marginTop: 6 }}>dados</summary><pre>{JSON.stringify(r.payload, null, 2).slice(0, 6000)}</pre></details>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={4} className="empty">Nenhum aviso ainda. Quando a Kirvano mandar a primeira venda, ela aparece aqui.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
