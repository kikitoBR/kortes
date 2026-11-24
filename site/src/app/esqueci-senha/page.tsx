import type { Metadata } from "next";
import { requestReset } from "./actions";

export const metadata: Metadata = { title: "Esqueci a senha · Kortes", robots: { index: false } };

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ enviado?: string; email?: string }> }) {
  const { enviado, email = "" } = await searchParams;
  return (
    <main className="soon" style={{ maxWidth: 420, margin: "0 auto" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="" width={56} height={56} />
      {enviado ? (
        <>
          <h1>Confira seu e-mail</h1>
          <p>Se existir uma conta com este e-mail, enviamos um link para criar uma nova senha. Ele vale por 1 hora.</p>
        </>
      ) : (
        <form action={requestReset} className="stack" style={{ textAlign: "left", width: "100%" }}>
          <h1 style={{ textAlign: "center" }}>Esqueci a senha</h1>
          <p className="muted" style={{ textAlign: "center", margin: 0 }}>Enviamos um link para você criar uma nova.</p>
          <label className="stack" style={{ gap: 6 }}>
            E-mail da conta
            <input type="email" name="email" defaultValue={email} required autoComplete="email" />
          </label>
          <button type="submit">Enviar link</button>
        </form>
      )}
    </main>
  );
}
