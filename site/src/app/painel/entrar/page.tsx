import type { Metadata } from "next";
import { login } from "../actions";

export const metadata: Metadata = { title: "Entrar · Kortes", robots: { index: false, follow: false } };

export default async function Entrar({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  const { erro } = await searchParams;
  const configured = Boolean(process.env.ADMIN_PASSWORD);
  return (
    <main className="login">
      <form action={login} className="card stack">
        <div className="row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" width={32} height={32} style={{ borderRadius: 8 }} />
          <h1 style={{ fontSize: 20 }}>Painel do Kortes</h1>
        </div>
        {!configured && <p className="error">Defina ADMIN_PASSWORD nas variáveis do projeto na Vercel.</p>}
        <label>
          Senha
          <input type="password" name="password" autoComplete="current-password" required autoFocus />
        </label>
        {erro && <p className="error">Senha incorreta.</p>}
        <button type="submit" disabled={!configured}>Entrar</button>
      </form>
    </main>
  );
}
