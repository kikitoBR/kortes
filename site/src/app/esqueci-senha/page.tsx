import type { Metadata } from "next";
import Link from "next/link";
import { AuthField, AuthFrame } from "../auth-frame";
import { Icon } from "../brand";
import { requestReset } from "./actions";

export const metadata: Metadata = { title: "Esqueci a senha · Kortes", robots: { index: false } };

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ enviado?: string; email?: string }> }) {
  const { enviado, email = "" } = await searchParams;
  const footer = <Link href="/"><Icon name="arrowLeft" size={16} /> Voltar para o site</Link>;
  if (enviado) {
    return (
      <AuthFrame icon="mail" tone="ok" title="Confira seu e‑mail" subtitle="Se existir uma conta com esse e-mail, o link para criar uma nova senha já está a caminho." footer={footer}>
        <ol className="auth-steps">
          <li>Abra o e-mail “Kortes: criar uma nova senha”. Se não aparecer, olhe o spam.</li>
          <li>Clique em “Criar nova senha”. O link vale por 1 hora.</li>
          <li>Volte ao Kortes no computador e entre com a senha nova.</li>
        </ol>
        <Link href="/esqueci-senha" className="button ghost">Enviar de novo</Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame icon="key" title="Esqueceu a senha?" subtitle="Digite o e-mail da sua conta do Kortes. Mandamos um link para você criar uma nova." footer={footer}>
      <form action={requestReset}>
        <AuthField icon="mail" label="E-mail da conta" type="email" name="email" defaultValue={email} required autoComplete="email" placeholder="voce@email.com" autoFocus />
        <button type="submit">Enviar link</button>
      </form>
    </AuthFrame>
  );
}
