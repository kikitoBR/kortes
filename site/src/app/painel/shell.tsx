import Link from "next/link";
import { db, describeDbError } from "@/lib/db";
import { logout } from "./actions";
import { Icon, Scissors } from "../brand";

const NAV = [
  { key: "mensagens", href: "/painel", label: "Mensagens", icon: "inbox" },
  { key: "clientes", href: "/painel/clientes", label: "Clientes", icon: "users" },
  { key: "pagamentos", href: "/painel/pagamentos", label: "Pagamentos", icon: "card" },
  { key: "avisos", href: "/painel/avisos", label: "Avisos", icon: "megaphone" },
] as const;

/** Messages waiting for an answer, for the menu's counter (0 when the database is not there). */
async function openThreads(): Promise<number> {
  try {
    const sql = await db();
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM support_threads WHERE status = 'open'`;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export async function Shell({ active, children }: { active: (typeof NAV)[number]["key"]; children: React.ReactNode }) {
  const open = await openThreads();
  return (
    <div className="pnl">
      <aside className="pnl-side">
        <Link href="/painel" className="pnl-brand">
          <Scissors size={28} />
          <span>Kortes<small>Painel</small></span>
        </Link>
        <nav className="pnl-nav" aria-label="Painel">
          {NAV.map((item) => (
            <Link key={item.key} href={item.href} aria-current={active === item.key ? "page" : undefined}>
              <Icon name={item.icon} />
              <span className="label">{item.label}</span>
              {item.key === "mensagens" && open ? <span className="count">{open}</span> : null}
            </Link>
          ))}
        </nav>
        <form action={logout}>
          <button type="submit"><Icon name="logout" /><span>Sair</span></button>
        </form>
      </aside>
      <main className="pnl-main">{children}</main>
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
      <h1 style={{ fontSize: 22 }}>O painel ainda não consegue usar o banco</h1>
      <p className="alert error">{message}</p>
      <p className="muted small">
        Na Vercel: Storage → conecte um banco Neon ao projeto (isso cria DATABASE_URL), depois Deployments → Redeploy.
      </p>
    </div>
  );
}
