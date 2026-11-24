import type { Metadata } from "next";
import { resetPassword } from "./actions";

export const metadata: Metadata = { title: "Nova senha · Kortes", robots: { index: false } };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string; ok?: string; erro?: string }> }) {
  const { token = "", ok, erro } = await searchParams;
  return (
    <main className="soon" style={{ maxWidth: 420, margin: "0 auto" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="" width={56} height={56} />
      {ok ? (
        <>
          <h1>Senha trocada</h1>
          <p>Abra o Kortes no seu computador e entre com a nova senha.</p>
        </>
      ) : (
        <form action={resetPassword} className="stack" style={{ textAlign: "left", width: "100%" }}>
          <h1 style={{ textAlign: "center" }}>Criar nova senha</h1>
          <input type="hidden" name="token" value={token} />
          <label className="stack" style={{ gap: 6 }}>
            Nova senha (mínimo 8 caracteres)
            <input type="password" name="password" minLength={8} required autoComplete="new-password" />
          </label>
          <label className="stack" style={{ gap: 6 }}>
            Repita a senha
            <input type="password" name="confirm" minLength={8} required autoComplete="new-password" />
          </label>
          {erro ? <p className="error">{erro}</p> : null}
          <button type="submit">Salvar nova senha</button>
        </form>
      )}
    </main>
  );
}
