import type { Metadata } from "next";
import Link from "next/link";
import { AuthField, AuthFrame } from "../auth-frame";
import { Icon } from "../brand";
import { resetPassword } from "./actions";

export const metadata: Metadata = { title: "Nova senha · Kortes", robots: { index: false } };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string; ok?: string; erro?: string }> }) {
  const { token = "", ok, erro } = await searchParams;
  if (ok) {
    return (
      <AuthFrame icon="check" tone="ok" title="Senha trocada" subtitle="Pronto! Abra o Kortes no seu computador e entre com a senha nova."
        footer={<Link href="/"><Icon name="arrowLeft" size={16} /> Voltar para o site</Link>} />
    );
  }
  if (!token) {
    return (
      <AuthFrame icon="lock" title="Link incompleto" subtitle="Abra o link do e-mail inteiro, ou peça um novo."
        footer={<Link href="/"><Icon name="arrowLeft" size={16} /> Voltar para o site</Link>}>
        <Link href="/esqueci-senha" className="button">Pedir um novo link</Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame icon="lock" title="Crie uma nova senha" subtitle="Ela vale para entrar no Kortes no seu computador."
      footer={<>Link expirado? <Link href="/esqueci-senha">Pedir outro</Link></>}>
      <form action={resetPassword}>
        <input type="hidden" name="token" value={token} />
        <AuthField icon="lock" label="Nova senha" hint="Pelo menos 8 caracteres." type="password" name="password" minLength={8} required autoComplete="new-password" autoFocus />
        <AuthField icon="lock" label="Repita a senha" type="password" name="confirm" minLength={8} required autoComplete="new-password" />
        {erro ? <p className="alert error">{erro}</p> : null}
        <button type="submit">Salvar nova senha</button>
      </form>
    </AuthFrame>
  );
}
