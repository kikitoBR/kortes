import Link from "next/link";
import { Icon, Scissors, type IconName } from "./brand";

/** The account pages' frame: warm light like the landing, one glass card in the middle. */
export function AuthFrame({ icon, tone, title, subtitle, children, footer }: {
  icon: IconName;
  tone?: "ok";
  title: string;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="auth">
      <div className="auth-glow" aria-hidden><i /><i /><i /></div>
      <div className="auth-box">
        <Link href="/" className="auth-logo"><Scissors size={30} /> Kortes</Link>
        <section className="auth-card">
          <span className={`auth-badge${tone === "ok" ? " ok" : ""}`}><Icon name={icon} size={24} /></span>
          <div className="auth-head">
            <h1>{title}</h1>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {children}
        </section>
        {footer ? <p className="auth-foot">{footer}</p> : null}
      </div>
    </main>
  );
}

/** An input with its icon on the left, as on the app's sign-in. */
export function AuthField({ icon, label, hint, ...input }: { icon: IconName; label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label>
      {label}
      <span className="auth-field">
        <Icon name={icon} size={18} />
        <input {...input} />
      </span>
      {hint ? <span className="auth-hint">{hint}</span> : null}
    </label>
  );
}
