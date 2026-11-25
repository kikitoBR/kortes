import Link from "next/link";
import { notFound } from "next/navigation";
import { CATEGORIES, STATUS_LABELS } from "@/lib/support";
import { deleteThread, reply, setThreadStatus } from "../../actions";
import { formatDate, painelDb, SetupNotice, Shell } from "../../shell";

export default async function Conversa({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sql = await painelDb();
  if (typeof sql === "string") return <Shell active="mensagens"><SetupNotice message={sql} /></Shell>;
  const [thread] = await sql`SELECT * FROM support_threads WHERE id = ${id}`;
  if (!thread) notFound();
  const messages = await sql`SELECT author, body, created_at FROM support_messages WHERE thread_id = ${id} ORDER BY created_at`;
  const [others] = await sql`SELECT count(*)::int AS n FROM support_threads WHERE license_hash = ${thread.license_hash} AND id <> ${id}`;

  return (
    <Shell active="mensagens">
      <Link href="/painel" className="back">← Mensagens</Link>
      <div className="layout2">
        <section className="stack">
          <div className="row spread">
            <h1 style={{ fontSize: 22 }}>{thread.subject as string}</h1>
            <span className={`badge ${thread.status}`}>{STATUS_LABELS[thread.status as string]}</span>
          </div>
          <div className="chat">
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.author}`}>
                {m.body as string}
                <time>{m.author === "admin" ? "Você" : "Cliente"} · {formatDate(m.created_at as Date)}</time>
              </div>
            ))}
          </div>
          <form action={reply} className="card stack">
            <input type="hidden" name="thread" value={id} />
            <label>
              Responder (o cliente vê no app)
              <textarea name="message" rows={5} maxLength={4000} required />
            </label>
            <div className="row">
              <button type="submit">Enviar resposta</button>
              <button type="submit" name="close" value="1" className="ghost">Enviar e encerrar</button>
            </div>
          </form>
        </section>
        <aside className="card stack">
          <dl className="meta">
            <dt>Cliente</dt><dd>{(thread.license_name as string) || "sem nome"}</dd>
            <dt>Tipo</dt><dd>{CATEGORIES[thread.category as keyof typeof CATEGORIES] ?? (thread.category as string)}</dd>
            <dt>Contato</dt><dd>{(thread.contact as string) || "—"}</dd>
            <dt>Versão</dt><dd>{(thread.app_version as string) || "—"}</dd>
            <dt>PC</dt><dd><code>{((thread.device as string) || "—").slice(0, 12)}</code></dd>
            <dt>Licença</dt><dd><code>{(thread.license_hash as string).slice(0, 12)}</code></dd>
            <dt>Aberta</dt><dd>{formatDate(thread.created_at as Date)}</dd>
            <dt>Outras</dt><dd>{others.n as number} conversa{(others.n as number) === 1 ? "" : "s"}</dd>
          </dl>
          <form action={setThreadStatus} className="row">
            <input type="hidden" name="thread" value={id} />
            {thread.status !== "closed" ? (
              <button type="submit" name="status" value="closed" className="ghost">Encerrar</button>
            ) : (
              <button type="submit" name="status" value="open" className="ghost">Reabrir</button>
            )}
          </form>
          <form action={deleteThread}>
            <input type="hidden" name="thread" value={id} />
            <button type="submit" className="danger">Apagar conversa</button>
          </form>
        </aside>
      </div>
    </Shell>
  );
}
