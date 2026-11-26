import Link from "next/link";
import { notFound } from "next/navigation";
import { accountById, FREE_CLIPS, FREE_CLIPS_PER_VIDEO, isPro, PLAN_LABELS, PLANS } from "@/lib/accounts";
import { formatDate, painelDb, SetupNotice, Shell } from "../../shell";
import { Icon } from "../../../brand";
import { addFreeClips, changePlan, makeResetLink, releaseDevice, resetFreeClips, saveNotes, toggleBlock } from "../actions";

export const dynamic = "force-dynamic";

export default async function ClientPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ aviso?: string; link?: string }>;
}) {
  const { id } = await params;
  const { aviso, link } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sql = await painelDb();
  if (typeof sql === "string") return <Shell active="clientes"><SetupNotice message={sql} /></Shell>;
  const account = await accountById(sql, id);
  if (!account) notFound();
  const clips = account.device
    ? await sql<{ source_key: string; clips: number; created_at: Date; email: string | null }[]>`
        SELECT f.source_key, f.clips, f.created_at, a.email FROM free_clips f LEFT JOIN accounts a ON a.id = f.account_id
        WHERE f.device = ${account.device} ORDER BY f.created_at DESC`
    : [];
  const [extra] = account.device ? await sql<{ extra_clips: number }[]>`SELECT extra_clips FROM free_devices WHERE device = ${account.device}` : [];
  const others = account.device
    ? await sql<{ id: string; email: string }[]>`SELECT DISTINCT a.id, a.email FROM free_clips f JOIN accounts a ON a.id = f.account_id WHERE f.device = ${account.device} AND a.id <> ${account.id}`
    : [];
  const jobs = await sql<CutJob[]>`
    SELECT id, kind, title, source_key, free, clips, app_version, created_at, finished_at
    FROM cut_jobs WHERE account_id = ${account.id} ORDER BY created_at DESC LIMIT 30`;
  const [usage] = await sql<{ cuts: number; videos: number; lives: number; last: Date | null; week: number }[]>`
    SELECT COALESCE(sum(clips), 0)::int AS cuts,
      count(*) FILTER (WHERE kind = 'video')::int AS videos,
      count(*) FILTER (WHERE kind = 'live')::int AS lives,
      max(created_at) AS last,
      COALESCE(sum(clips) FILTER (WHERE created_at > now() - interval '7 days'), 0)::int AS week
    FROM cut_jobs WHERE account_id = ${account.id}`;
  const payments = await sql<{ event: string; result: string; created_at: Date }[]>`
    SELECT event, result, created_at FROM payment_events WHERE email = ${account.email} ORDER BY created_at DESC LIMIT 20`;
  const limit = FREE_CLIPS + (extra?.extra_clips ?? 0);
  const used = clips.reduce((sum, c) => sum + c.clips, 0);
  const until = account.plan_until ? new Date(account.plan_until).toISOString().slice(0, 10) : "";
  const hidden = <input type="hidden" name="account" value={account.id} />;
  const paid = isPro(account);
  const planTone = account.status === "blocked" ? "blocked" : paid ? "pro" : account.plan !== "free" ? "expired" : "free";
  const planLabel = account.status === "blocked" ? "Bloqueada" : paid ? PLAN_LABELS[account.plan] : account.plan !== "free" ? `${PLAN_LABELS[account.plan]} vencido` : "Grátis";
  return (
    <Shell active="clientes">
      <Link href="/painel/clientes" className="back"><Icon name="arrowLeft" size={15} /> Clientes</Link>
      <div className="pagehead">
        <div>
          <h1 style={{ overflowWrap: "anywhere" }}>{account.email}</h1>
          <p>{account.name || "Sem nome"} · conta criada em {formatDate(account.created_at)} · via {account.source === "kirvano" ? "compra na Kirvano" : account.source === "painel" ? "painel" : "app"}</p>
        </div>
        <span className={`badge ${planTone}`}>{planLabel}</span>
      </div>

      <div className="stack">
        {aviso ? <p className="alert ok">{aviso}</p> : null}
        {link ? (
          <div className="card stack">
            <h2 className="card-title"><Icon name="key" /> Link para criar uma nova senha (vale 24 h)</h2>
            <input readOnly value={link} />
            <span className="muted small">Mande para o cliente pelo canal que preferir.</span>
          </div>
        ) : null}

        <div className="grid2">
          <div className="card stack">
            <h2 className="card-title"><Icon name="card" /> Plano</h2>
            <dl className="kv">
              <div><dt>Plano</dt><dd>{PLAN_LABELS[account.plan]}</dd></div>
              <div><dt>Válido até</dt><dd>{account.plan === "lifetime" ? "Para sempre" : account.plan_until ? formatDate(account.plan_until) : "—"}</dd></div>
            </dl>
            <form action={changePlan} className="row">
              {hidden}
              <select name="plan" defaultValue={account.plan} style={{ flex: "1 1 140px", width: "auto" }}>
                {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
              </select>
              <input type="date" name="until" defaultValue={until} title="Válido até (mensal/anual)" style={{ flex: "1 1 140px", width: "auto" }} />
              <button type="submit">Salvar</button>
            </form>
          </div>

          <div className="card stack">
            <h2 className="card-title"><Icon name="pc" /> Computador</h2>
            <dl className="kv">
              <div><dt>PC</dt><dd>{account.device ? <code>{account.device.slice(0, 16)}…</code> : "Nenhum ainda"}</dd></div>
              <div><dt>Último login</dt><dd>{account.last_login_at ? formatDate(account.last_login_at) : "Nunca"}</dd></div>
              <div><dt>Senha</dt><dd>{account.password_hash ? "Definida" : "Primeiro acesso pendente"}</dd></div>
            </dl>
            <p className="muted small">{account.device ? "A conta só entra neste PC. Libere para o cliente trocar de computador." : "O próximo login prende a conta ao computador."}</p>
            <form action={releaseDevice}>{hidden}<button type="submit" className="ghost" disabled={!account.device}>Liberar troca de PC</button></form>
          </div>
        </div>

        <div className="card stack">
          <h2 className="card-title"><Icon name="scissors" /> Uso do app</h2>
          <div className="stats" style={{ marginBottom: 0 }}>
            <div className="stat"><b>{usage.cuts}</b><span>cortes feitos</span></div>
            <div className="stat"><b>{usage.week}</b><span>nos últimos 7 dias</span></div>
            <div className="stat"><b>{usage.videos}</b><span>{usage.videos === 1 ? "vídeo" : "vídeos"}</span></div>
            <div className="stat"><b>{usage.lives}</b><span>{usage.lives === 1 ? "live" : "lives"}</span></div>
          </div>
          <dl className="kv">
            <div><dt>Versão do app</dt><dd>{account.app_version ? `Kortes ${account.app_version}` : "—"}</dd></div>
            <div><dt>Visto por último</dt><dd>{account.last_seen_at ? formatDate(account.last_seen_at) : "—"}</dd></div>
            <div><dt>Último vídeo ou live</dt><dd>{usage.last ? formatDate(usage.last) : "Nenhum ainda"}</dd></div>
          </dl>
          {jobs.length ? (
            <ul className="history">
              {jobs.map((job) => (
                <li key={job.id}>
                  <span style={{ overflowWrap: "anywhere" }}>
                    <span className={`badge ${job.kind === "live" ? "open" : "closed"}`} style={{ marginRight: 8 }}>{job.kind === "live" ? "Live" : "Vídeo"}</span>
                    <SourceLink job={job} />
                    {job.free ? <span className="muted small"> · grátis</span> : null}
                  </span>
                  <span className="muted" style={{ whiteSpace: "nowrap" }}>{jobResult(job)} · {formatDate(job.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">Nenhum vídeo ou live registrado. O registro começa na versão 1.0.10 do app.</p>}
        </div>

        <div className="card stack">
          <div className="row spread">
            <h2 className="card-title"><Icon name="scissors" /> Cortes grátis deste PC</h2>
            <span className="muted small"><b style={{ color: "var(--fg)" }}>{used}</b> de {limit} usados · até {FREE_CLIPS_PER_VIDEO} por vídeo ou live</span>
          </div>
          <div className="meter"><i style={{ width: `${limit ? Math.min(100, (used / limit) * 100) : 0}%` }} /></div>
          {others.length ? <p className="alert error small">Este PC também usou cortes grátis com: {others.map((o) => o.email).join(", ")}</p> : null}
          {clips.length ? (
            <ul className="history">
              {clips.map((c) => (
                <li key={c.source_key}>
                  <span style={{ overflowWrap: "anywhere" }}>{c.source_key.slice(0, 80)}{c.email && c.email !== account.email ? <span className="muted"> · {c.email}</span> : null}</span>
                  <span className="muted" style={{ whiteSpace: "nowrap" }}>{c.clips} {c.clips === 1 ? "corte" : "cortes"} · {formatDate(c.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">Nenhum vídeo cortado no plano grátis ainda.</p>}
          {account.device ? (
            <div className="row">
              <form action={addFreeClips} className="row">
                {hidden}<input type="hidden" name="device" value={account.device} />
                <input type="number" name="amount" defaultValue={5} min={-50} max={50} style={{ width: 90 }} aria-label="Quantidade" />
                <button type="submit">Dar cortes extras</button>
              </form>
              <form action={resetFreeClips}>{hidden}<input type="hidden" name="device" value={account.device} /><button type="submit" className="ghost">Zerar cortes do PC</button></form>
            </div>
          ) : null}
        </div>

        <div className="grid2">
          <div className="card stack">
            <h2 className="card-title"><Icon name="lock" /> Acesso</h2>
            <p className="muted small">O link deixa o cliente criar uma senha nova, sem precisar de e-mail. Bloquear tira a IA da conta na hora.</p>
            <div className="row">
              <form action={makeResetLink}>{hidden}<button type="submit" className="ghost">Gerar link de nova senha</button></form>
              <form action={toggleBlock}>{hidden}<button type="submit" className={account.status === "blocked" ? "ghost" : "danger"}>{account.status === "blocked" ? "Desbloquear" : "Bloquear conta"}</button></form>
            </div>
          </div>

          <form action={saveNotes} className="card stack">
            {hidden}
            <h2 className="card-title"><Icon name="note" /> Anotações</h2>
            <textarea name="notes" defaultValue={account.notes} rows={3} placeholder="Só você vê." />
            <button type="submit" className="ghost" style={{ justifySelf: "start" }}>Salvar anotações</button>
          </form>
        </div>

        {payments.length ? (
          <div className="card stack">
            <h2 className="card-title"><Icon name="receipt" /> Pagamentos</h2>
            <ul className="history">
              {payments.map((p, i) => (
                <li key={i}><span><code>{p.event}</code> {p.result}</span><span className="muted" style={{ whiteSpace: "nowrap" }}>{formatDate(p.created_at)}</span></li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

type CutJob = {
  id: string;
  kind: string;
  title: string;
  source_key: string;
  free: boolean;
  clips: number | null;
  app_version: string;
  created_at: Date;
  finished_at: Date | null;
};

function jobResult(job: CutJob) {
  if (job.clips === null) {
    // Still running, or the app closed before it finished (no count came back).
    return Date.now() - new Date(job.created_at).getTime() < 12 * 3600e3 ? "em andamento" : "sem retorno";
  }
  if (job.clips === 0) return "nenhum corte";
  return `${job.clips} ${job.clips === 1 ? "corte" : "cortes"}`;
}

/** The video or live, linked when its key says where it is ("yt:<id>", "live:<channel>:<day>"). */
function SourceLink({ job }: { job: CutJob }) {
  const key = job.source_key;
  let href = "";
  if (key.startsWith("yt:")) href = `https://youtu.be/${key.slice(3)}`;
  else if (key.startsWith("live:")) {
    const base = key.slice(5).replace(/:\d{4}-\d{2}-\d{2}$/, "");
    href = /^https?:\/\//.test(base) ? base : /^[\w-]{11}$/.test(base) ? `https://youtu.be/${base}` : "";
  }
  const label = job.title || (key.startsWith("file:") ? "Arquivo enviado" : key.slice(0, 60));
  return href ? <a href={href} target="_blank" rel="noreferrer">{label}</a> : <span>{label}</span>;
}
