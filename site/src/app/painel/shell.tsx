import Link from "next/link";
import { db, describeDbError } from "@/lib/db";
import { logout } from "./actions";

export function Shell({ active, children }: { active: "mensagens" | "avisos"; children: React.ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/painel" className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" width={28} height={28} />
          Painel do Kortes
        </Link>
        <nav aria-label="Painel">
          <Link href="/painel" aria-current={active === "mensagens" ? "page" : undefined}>Mensagens</Link>
          <Link href="/painel/avisos" aria-current={active === "avisos" ? "page" : undefined}>Avisos</Link>
        </nav>
        <form action={logout}>
          <button type="submit" className="ghost">Sair</button>
        </form>
      </header>
      {children}
    </div>
  );
}

export function formatDate(value: Date | string) {
  return new Date(value).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The database, or a message saying why it is not usable (shown instead of a blank error page). */
export async function painelDb() {
  try {
    return await db();
  } catch (error) {
    console.error("painel: database unavailable", error);
    return describeDbError(error);
  }
}

export function SetupNotice({ message }: { message: string }) {
  return (
    <div className="card stack">
      <h1 style={{ fontSize: 20 }}>O painel ainda não consegue usar o banco</h1>
      <p className="error" style={{ margin: 0 }}>{message}</p>
      <p className="muted small" style={{ margin: 0 }}>
        Na Vercel: Storage → conecte um banco Neon ao projeto (isso cria DATABASE_URL), depois Deployments → Redeploy.
      </p>
    </div>
  );
}
