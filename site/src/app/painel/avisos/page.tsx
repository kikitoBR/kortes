import { deleteAnnouncement, saveAnnouncement } from "../actions";
import { formatDate, painelDb, SetupNotice, Shell } from "../shell";

type Row = {
  id: string;
  title: string;
  description: string;
  action: string;
  href: string;
  is_published: boolean;
  published_at: Date;
};

/** "2026-11-23T14:30" in Brasília time, for <input type="datetime-local">. */
function localValue(date: Date) {
  const shifted = new Date(date.getTime() - 3 * 3600 * 1000);
  return shifted.toISOString().slice(0, 16);
}

function AnnouncementForm({ item }: { item?: Row }) {
  return (
    <form action={saveAnnouncement} className="stack">
      {item && <input type="hidden" name="id" value={item.id} />}
      <label>
        Título
        <input type="text" name="title" maxLength={120} required defaultValue={item?.title} />
      </label>
      <label>
        Texto
        <textarea name="description" maxLength={2000} rows={3} required defaultValue={item?.description} />
      </label>
      <div className="row" style={{ alignItems: "end" }}>
        <label style={{ flex: "2 1 240px" }}>
          Link (opcional): https://... ou uma página do app, como /settings
          <input type="text" name="href" maxLength={500} defaultValue={item?.href} placeholder="https://instagram.com/kortes" />
        </label>
        <label style={{ flex: "1 1 160px" }}>
          Texto do botão
          <input type="text" name="action" maxLength={80} defaultValue={item?.action} placeholder="Ver vídeo" />
        </label>
      </div>
      <div className="row" style={{ alignItems: "end" }}>
        <label style={{ flex: "0 1 240px" }}>
          Publicar em (horário de Brasília)
          <input type="datetime-local" name="published_at" defaultValue={localValue(item?.published_at ?? new Date())} />
        </label>
        <label className="check">
          <input type="checkbox" name="published" defaultChecked={item ? item.is_published : true} />
          Publicado
        </label>
        <button type="submit">{item ? "Salvar" : "Criar aviso"}</button>
      </div>
    </form>
  );
}

export default async function Avisos({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const { erro, ok } = await searchParams;
  const sql = await painelDb();
  if (typeof sql === "string") return <Shell active="avisos"><SetupNotice message={sql} /></Shell>;
  const items = (await sql`SELECT * FROM announcements ORDER BY published_at DESC`) as unknown as Row[];
  const now = Date.now();

  return (
    <Shell active="avisos">
      <div className="pagehead">
        <div>
          <h1>Avisos</h1>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            Aparecem em &quot;Novidades&quot; no Kortes de todos os clientes (o app confere a cada poucos minutos).
          </p>
        </div>
      </div>
      <div className="stack">
        {erro && <p className="error">{erro}</p>}
        {ok && <p className="notice">Aviso salvo.</p>}
        <section className="card stack">
          <h2 style={{ fontSize: 16 }}>Novo aviso</h2>
          <AnnouncementForm />
        </section>
        {items.map((item) => {
          const scheduled = item.is_published && item.published_at.getTime() > now;
          return (
            <section key={item.id} className="card stack">
              <div className="row spread">
                <h2 style={{ fontSize: 16 }}>{item.title}</h2>
                <span className={`badge ${item.is_published ? (scheduled ? "" : "answered") : "draft"}`}>
                  {item.is_published ? (scheduled ? `Agendado · ${formatDate(item.published_at)}` : `Publicado · ${formatDate(item.published_at)}`) : "Rascunho"}
                </span>
              </div>
              <p className="muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{item.description}</p>
              {item.href && <p className="small" style={{ margin: 0 }}>{item.action} → <code>{item.href}</code></p>}
              <details className="edit">
                <summary>Editar</summary>
                <div style={{ marginTop: 12 }}><AnnouncementForm item={item} /></div>
              </details>
              <form action={deleteAnnouncement}>
                <input type="hidden" name="id" value={item.id} />
                <button type="submit" className="danger">Apagar</button>
              </form>
            </section>
          );
        })}
      </div>
    </Shell>
  );
}
