import Link from "next/link";
import { notFound } from "next/navigation";
import { accountById, FREE_CLIPS, FREE_CLIPS_PER_VIDEO, isPro, PLAN_LABELS, PLANS } from "@/lib/accounts";
import { formatDate, painelDb, SetupNotice, Shell } from "../../shell";
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
  const payments = await sql<{ event: string; result: string; created_at: Date }[]>`
    SELECT event, result, created_at FROM payment_events WHERE email = ${account.email} ORDER BY created_at DESC LIMIT 20`;
  const limit = FREE_CLIPS + (extra?.extra_clips ?? 0);
  const used = clips.reduce((sum, c) => sum + c.clips, 0);
  const until = account.plan_until ? new Date(account.plan_until).toISOString().slice(0, 10) : "";
  const hidden = <input type="hidden" name="account" value={account.id} />;
  return (
    <Shell active="clientes">
      <div className="stack">
        <Link href="/painel/clientes" className="muted small">← Clientes</Link>
        <div className="row spread">
          <h1 style={{ fontSize: 22 }}>{account.email}</h1>
          <span className={isPro(account) ? "" : "muted"}>{isPro(account) ? PLAN_LABELS[account.plan] : "Grátis"}{account.status === "blocked" ? " · bloqueada" : ""}</span>
        </div>
        {aviso ? <p className="card" style={{ margin: 0 }}>{aviso}</p> : null}
        {link ? (
          <div className="card stack">
            <b>Link para criar uma nova senha (vale 24 h)</b>
            <input readOnly value={link} />
            <span className="muted small">Mande para o cliente pelo canal que preferir.</span>
          </div>
        ) : null}

        <div className="card stack">
          <h2 style={{ fontSize: 16 }}>Plano</h2>
          <form action={changePlan} className="row">
            {hidden}
            <select name="plan" defaultValue={account.plan}>
              {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
            </select>
            <input type="date" name="until" defaultValue={until} title="Válido até (mensal/anual)" />
            <button type="submit">Salvar plano</button>
          </form>
          <p className="muted small" style={{ margin: 0 }}>
            Criada em {formatDate(account.created_at)} · origem: {account.source} · último login: {account.last_login_at ? formatDate(account.last_login_at) : "nunca"} · senha: {account.password_hash ? "definida" : "ainda não (primeiro acesso)"}
          </p>
        </div>

        <div className="card stack">
          <h2 style={{ fontSize: 16 }}>Computador</h2>
          <p style={{ margin: 0 }}>{account.device ? <>Presa ao PC <code>{account.device}</code></> : "Nenhum PC ainda: o próximo login prende a conta."}</p>
          <form action={releaseDevice}>{hidden}<button type="submit" disabled={!account.device}>Liberar troca de PC</button></form>
        </div>

        <div className="card stack">
          <h2 style={{ fontSize: 16 }}>Cortes grátis deste PC: {used} de {limit} <span style={{ color: "var(--muted)", fontWeight: 400 }}>(até {FREE_CLIPS_PER_VIDEO} por vídeo ou live)</span></h2>
          {others.length ? <p className="error small" style={{ margin: 0 }}>Este PC também usou cortes grátis com: {others.map((o) => o.email).join(", ")}</p> : null}
          <ul className="small" style={{ margin: 0 }}>
            {clips.map((c) => <li key={c.source_key}>{formatDate(c.created_at)} · {c.clips} {c.clips === 1 ? "corte" : "cortes"} · {c.source_key.slice(0, 80)}{c.email && c.email !== account.email ? ` · (${c.email})` : ""}</li>)}
          </ul>
          {account.device ? (
            <div className="row">
              <form action={addFreeClips} className="row">
                {hidden}<input type="hidden" name="device" value={account.device} />
                <input type="number" name="amount" defaultValue={5} min={-50} max={50} style={{ width: 80 }} />
                <button type="submit">Dar cortes extras</button>
              </form>
              <form action={resetFreeClips}>{hidden}<input type="hidden" name="device" value={account.device} /><button type="submit" className="ghost">Zerar cortes do PC</button></form>
            </div>
          ) : null}
        </div>

        <div className="card stack">
          <h2 style={{ fontSize: 16 }}>Acesso</h2>
          <div className="row">
            <form action={makeResetLink}>{hidden}<button type="submit">Gerar link de nova senha</button></form>
            <form action={toggleBlock}>{hidden}<button type="submit" className="ghost">{account.status === "blocked" ? "Desbloquear" : "Bloquear conta"}</button></form>
          </div>
        </div>

        <form action={saveNotes} className="card stack">
          {hidden}
          <h2 style={{ fontSize: 16 }}>Anotações</h2>
          <textarea name="notes" defaultValue={account.notes} rows={3} />
          <button type="submit" style={{ alignSelf: "flex-start" }}>Salvar</button>
        </form>

        {payments.length ? (
          <div className="card stack">
            <h2 style={{ fontSize: 16 }}>Pagamentos</h2>
            <ul className="small" style={{ margin: 0 }}>
              {payments.map((p, i) => <li key={i}>{formatDate(p.created_at)} · {p.event} · {p.result}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
