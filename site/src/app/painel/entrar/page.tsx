import type { Metadata } from "next";
import { AuthField, AuthFrame } from "../../auth-frame";
import { login } from "../actions";

export const metadata: Metadata = { title: "Entrar · Painel do Kortes", robots: { index: false, follow: false } };

export default async function Entrar({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  const { erro } = await searchParams;
  const configured = Boolean(process.env.ADMIN_PASSWORD);
  return (
    <AuthFrame icon="lock" title="Painel do Kortes" subtitle="Clientes, pagamentos, mensagens e avisos.">
      <form action={login}>
        {!configured ? <p className="alert error">Defina ADMIN_PASSWORD nas variáveis do projeto na Vercel.</p> : null}
        <AuthField icon="lock" label="Senha" type="password" name="password" autoComplete="current-password" required autoFocus />
        {erro ? <p className="alert error">Senha incorreta.</p> : null}
        <button type="submit" disabled={!configured}>Entrar</button>
      </form>
    </AuthFrame>
  );
}
