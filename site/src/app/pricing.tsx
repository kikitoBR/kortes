// The plans, shared by the landing (#planos) and /planos (where the app's "Assinar" opens).
// Checkout links come from the environment: KIRVANO_CHECKOUT_MONTHLY / _YEARLY / _LIFETIME.

const PLANS = [
  {
    id: "free",
    name: "Grátis",
    price: "R$ 0",
    period: "",
    note: "para experimentar",
    features: ["15 cortes grátis", "Até 5 cortes por vídeo ou live", "Vídeos e lives de qualquer duração", "Com marca d'água do Kortes"],
    cta: "Baixar e testar",
    href: "#baixar",
  },
  {
    id: "monthly",
    name: "Pro mensal",
    price: "R$ 49,90",
    period: "/mês",
    note: "cancele quando quiser",
    features: ["Cortes ilimitados", "Corte ao vivo sem limite", "Sem marca d'água", "IA inclusa, sem créditos"],
    cta: "Assinar mensal",
    env: "KIRVANO_CHECKOUT_MONTHLY",
  },
  {
    id: "yearly",
    name: "Pro anual",
    price: "R$ 397",
    period: "/ano",
    note: "≈ R$ 33 por mês · economize 33%",
    features: ["Tudo do Pro mensal", "Pague 8 meses, use 12"],
    cta: "Assinar anual",
    env: "KIRVANO_CHECKOUT_YEARLY",
    featured: true,
  },
  {
    id: "lifetime",
    name: "Vitalício",
    price: "R$ 697",
    period: " uma vez",
    note: "pague uma vez, use para sempre",
    features: ["Tudo do Pro", "Sem mensalidade", "Todas as atualizações"],
    cta: "Comprar vitalício",
    env: "KIRVANO_CHECKOUT_LIFETIME",
  },
] as const;

export function Pricing() {
  return (
    <div className="lp-plans">
      {PLANS.map((plan) => {
        const href = "env" in plan ? process.env[plan.env] || "" : plan.href;
        return (
          <article key={plan.id} className={`lp-glass lp-plan${"featured" in plan && plan.featured ? " is-featured" : ""}`}>
            {"featured" in plan && plan.featured ? <span className="lp-plan-badge">Mais escolhido</span> : null}
            <h3>{plan.name}</h3>
            <p className="lp-plan-price"><b>{plan.price}</b><span>{plan.period}</span></p>
            <p className="lp-plan-note">{plan.note}</p>
            <ul>
              {plan.features.map((f) => <li key={f}>{f}</li>)}
            </ul>
            {href ? (
              <a className={`lp-btn${"featured" in plan && plan.featured ? "" : " lp-btn-ghost"}`} href={href}>{plan.cta}</a>
            ) : (
              <span className="lp-btn lp-btn-ghost is-disabled" aria-disabled>Em breve</span>
            )}
          </article>
        );
      })}
    </div>
  );
}
