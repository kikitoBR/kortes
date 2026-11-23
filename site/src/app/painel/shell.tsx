import Link from "next/link";
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
