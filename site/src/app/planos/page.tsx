import type { Metadata } from "next";
import { geist, syne } from "../fonts";
import { Pricing } from "../pricing";
import "../landing.css";

export const metadata: Metadata = {
  title: "Planos · Kortes",
  description: "Kortes Pro: cortes ilimitados, corte ao vivo e sem marca d'água. Mensal, anual ou vitalício.",
};

export default function PlansPage() {
  return (
    <main className={`lp ${syne.variable} ${geist.variable}`}>
      <div className="lp-bg" aria-hidden><i /><i /><i /></div>
      <section className="lp-section" style={{ paddingTop: 72, paddingBottom: 96 }}>
        <a href="/" className="lp-logo" style={{ marginBottom: 40, display: "inline-flex" }}>Kortes</a>
        <p className="lp-eyebrow">Planos</p>
        <h1 className="lp-h2">Corte sem limite. <span>Escolha o seu plano.</span></h1>
        <p className="lp-lead">Use o mesmo e-mail da compra para entrar no Kortes: no primeiro login você cria a sua senha.</p>
        <Pricing />
      </section>
    </main>
  );
}
