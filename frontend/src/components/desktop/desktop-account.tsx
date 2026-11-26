"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, Crown, ExternalLink, Loader2, LogOut, Scissors, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FORGOT_PASSWORD_URL, PLANS_URL } from "@/lib/edition";
import { cn } from "@/lib/utils";

/** The Kortes account this computer is signed in to (read live from the site). */
export type DesktopAccount = {
  signed_in: boolean;
  email?: string;
  name?: string;
  plan?: "free" | "monthly" | "yearly" | "lifetime";
  planLabel?: string;
  pro?: boolean;
  planUntil?: string | null;
  /** Free plan: cuts used of `limit`, at most `perVideo` per video or live. */
  free?: { used: number; limit: number; perVideo?: number } | null;
  offline?: boolean;
  error?: string;
};

type Step = "email" | "login" | "signup" | "first";

class AccountRequestError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

async function accountRequest(path: string, body?: Record<string, string>): Promise<{ account: DesktopAccount }> {
  const response = await fetch(`/api/desktop/account${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as { detail?: string; code?: string; account?: DesktopAccount };
  if (!response.ok || !data.account) {
    throw new AccountRequestError(data.detail || "Não deu certo. Tente de novo.", data.code);
  }
  return { account: data.account };
}

export async function fetchDesktopAccount(): Promise<DesktopAccount | null> {
  try {
    const response = await fetch("/api/desktop/account", { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as DesktopAccount;
  } catch {
    return null;
  }
}

/** The account for the home page banner; `refresh` after a new video. */
export function useDesktopAccount(enabled: boolean) {
  const [account, setAccount] = useState<DesktopAccount | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    setAccount(await fetchDesktopAccount());
  }, [enabled]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { account, refresh };
}

const perVideo = (account: DesktopAccount) => account.free?.perVideo || 5;

function freeLeft(account: DesktopAccount) {
  if (!account.free) return null;
  return Math.max(0, account.free.limit - account.free.used);
}

function formatUntil(value: string | null | undefined) {
  if (!value) return null;
  return new Date(value).toLocaleDateString("pt-BR");
}

/** Free cuts left, as a bar. */
function FreeMeter({ used, limit }: { used: number; limit: number }) {
  const left = Math.max(0, limit - used);
  return (
    <div className="w-40 space-y-1" aria-label={`${used} de ${limit} cortes grátis usados`}>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${limit ? (left / limit) * 100 : 0}%` }} />
      </div>
      <p className="text-right text-xs tabular-nums text-muted-foreground">{left} de {limit}</p>
    </div>
  );
}

/** Sign in / create the free account / first access, then the account's plan and free cuts. */
export function AccountCard({ account, onChange }: { account: DesktopAccount; onChange: () => Promise<void> }) {
  const [leaving, setLeaving] = useState(false);

  const signOut = async () => {
    if (!window.confirm("Sair da conta neste computador? Para voltar, entre de novo com seu e-mail e senha.")) return;
    setLeaving(true);
    try {
      await accountRequest("/logout");
      await onChange();
    } finally {
      setLeaving(false);
    }
  };

  return (
    <section className="rounded-2xl border bg-background">
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <UserRound className="size-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Sua conta Kortes</h2>
          <p className="text-xs text-muted-foreground">
            {account.signed_in
              ? "A conta libera a IA que escolhe os melhores momentos dos seus vídeos."
              : "Entre com o e-mail da sua compra, ou com o seu e-mail para criar uma conta grátis com 15 cortes."}
          </p>
        </div>
      </div>
      <div className="space-y-4 p-5">
        {account.signed_in ? (
          <SignedIn account={account} leaving={leaving} onSignOut={() => void signOut()} />
        ) : (
          <SignInForm error={account.error} onDone={onChange} />
        )}
      </div>
    </section>
  );
}

function SignedIn({ account, leaving, onSignOut }: { account: DesktopAccount; leaving: boolean; onSignOut: () => void }) {
  const left = freeLeft(account);
  const until = account.plan === "lifetime" ? null : formatUntil(account.planUntil);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
          <Check className="size-3.5" />
        </span>
        <span className="font-medium">{account.email || "Conta conectada"}</span>
        {account.planLabel ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
              account.pro ? "bg-brand/10 text-brand" : "bg-muted text-muted-foreground",
            )}
          >
            {account.pro ? <Crown className="size-3" /> : null}
            {account.planLabel}
          </span>
        ) : null}
      </div>
      {account.offline ? (
        <p className="text-xs text-muted-foreground">Sem conexão com o site do Kortes agora; o plano aparece quando a internet voltar.</p>
      ) : null}
      {account.pro && until ? <p className="text-sm text-muted-foreground">Renova em {until}.</p> : null}
      {account.free ? (
        <div className="space-y-2 rounded-xl bg-muted/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">
                {left === 0 ? "Seus cortes grátis acabaram" : `${left} ${left === 1 ? "corte grátis restante" : "cortes grátis restantes"}`}
              </p>
              <p className="text-xs text-muted-foreground">
                Até {perVideo(account)} por vídeo ou live, com a marca d&apos;água do Kortes.
              </p>
            </div>
            <FreeMeter used={Math.min(account.free.used, account.free.limit)} limit={account.free.limit} />
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {account.pro ? null : (
          <Button asChild size="sm">
            <a href={PLANS_URL} target="_blank" rel="noreferrer">
              <Crown className="size-4" /> Assinar o Kortes Pro
            </a>
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={leaving} onClick={onSignOut}>
          <LogOut className="size-4" /> {leaving ? "Saindo…" : "Sair"}
        </Button>
      </div>
    </div>
  );
}

const STEP_TEXT: Record<Exclude<Step, "email">, { button: string; busy: string }> = {
  login: { button: "Entrar", busy: "Entrando…" },
  signup: { button: "Criar conta grátis", busy: "Criando…" },
  first: { button: "Criar senha e entrar", busy: "Entrando…" },
};

/** Which step follows the e-mail (asked to the site; an older site falls back to the password). */
async function nextStep(email: string): Promise<Exclude<Step, "email">> {
  const response = await fetch("/api/desktop/account/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = (await response.json().catch(() => ({}))) as { next?: string; detail?: string };
  if (response.status === 400) throw new AccountRequestError(data.detail || "Digite um e-mail válido.");
  // No internet: say so. Any other trouble with this step: ask the password, as before.
  if (response.status === 502) throw new AccountRequestError(data.detail || "Não deu para falar com o servidor do Kortes.");
  if (!response.ok) return "login";
  return data.next === "first" ? "first" : data.next === "new" ? "signup" : "login";
}

const STEP_NOTICE: Partial<Record<Step, string>> = {
  first: "Encontramos sua compra! É o seu primeiro acesso: crie uma senha para entrar.",
  signup: "Ainda não existe conta com este e-mail. Crie uma conta grátis com 15 cortes para testar. Se você comprou, confira se é o mesmo e-mail da compra.",
};

/** E-mail first; then the password, the first password of a purchase, or a free account. */
function SignInForm({ error: initialError, onDone }: { error?: string; onDone: () => Promise<void> }) {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const goTo = (next: Step, message: string | null = null) => {
    setStep(next);
    setError(message);
    setPassword("");
    setConfirm("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const typed = email.trim();
    if (step === "email") {
      setBusy(true);
      try {
        goTo(await nextStep(typed));
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Não deu certo. Tente de novo.");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (step !== "login" && password.length < 8) {
      setError("A senha precisa ter pelo menos 8 caracteres.");
      return;
    }
    if (step !== "login" && password !== confirm) {
      setError("As duas senhas não são iguais.");
      return;
    }
    setBusy(true);
    try {
      const path = step === "login" ? "/login" : step === "signup" ? "/signup" : "/set-password";
      await accountRequest(path, { email: typed, password, name: name.trim() });
      await onDone();
    } catch (exc) {
      const code = exc instanceof AccountRequestError ? exc.code : undefined;
      const message = exc instanceof Error ? exc.message : "Não deu certo. Tente de novo.";
      // The account changed between the steps (bought meanwhile, or the password was just created).
      if (code === "needs_password") goTo("first");
      else if (code === "no_account") goTo("signup");
      else if (code === "has_password") goTo("login", message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  };

  const notice = STEP_NOTICE[step];
  return (
    <div className="space-y-4">
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        {step === "email" ? (
          <>
            <p className="text-sm text-muted-foreground">
              Digite seu e-mail. Se você acabou de comprar, use o e-mail da compra.
            </p>
            <Input
              type="email"
              placeholder="Seu e-mail"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <span className="truncate font-medium">{email.trim()}</span>
            <button
              type="button"
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => goTo("email")}
            >
              Trocar e-mail
            </button>
          </div>
        )}

        {notice ? <p className="rounded-lg bg-brand/10 p-3 text-sm text-foreground">{notice}</p> : null}

        {step === "signup" ? (
          <Input placeholder="Seu nome (opcional)" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
        ) : null}
        {step === "email" ? null : (
          <Input
            type="password"
            placeholder={step === "login" ? "Sua senha" : "Crie uma senha (mínimo 8 caracteres)"}
            autoComplete={step === "login" ? "current-password" : "new-password"}
            autoFocus={step !== "signup"}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
        {step === "first" || step === "signup" ? (
          <Input
            type="password"
            placeholder="Repita a senha"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        ) : null}
        {error ? (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={busy || !email.trim() || (step !== "email" && !password)}>
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" /> {step === "email" ? "Verificando…" : STEP_TEXT[step].busy}
            </>
          ) : step === "email" ? (
            "Continuar"
          ) : (
            STEP_TEXT[step].button
          )}
        </Button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        {step === "login" ? (
          <a href={FORGOT_PASSWORD_URL} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
            Esqueci minha senha
          </a>
        ) : (
          <span />
        )}
        <a href={PLANS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
          Ver planos <ExternalLink className="size-3" />
        </a>
      </div>
      {step === "signup" ? (
        <p className="text-xs text-muted-foreground">
          A conta grátis dá 15 cortes, até 5 por vídeo ou live, com marca d&apos;água. Cada conta funciona em 1
          computador.
        </p>
      ) : null}
    </div>
  );
}

/** Home page strip for the free plan: cuts left and the way to Pro. */
export function FreePlanBanner({ account, message }: { account: DesktopAccount | null; message?: string | null }) {
  if (!account?.signed_in || account.pro || !account.free) return null;
  const left = freeLeft(account) ?? 0;
  return (
    <div
      className={cn(
        "mx-auto mt-5 flex max-w-xl flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-2xl border px-4 py-2.5 text-sm",
        message || left === 0 ? "border-brand/40 bg-brand/5" : "bg-background",
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <Scissors className="size-4 text-brand" />
        {message ||
          (left === 0
            ? "Seus cortes grátis acabaram."
            : `Plano grátis: ${left} ${left === 1 ? "corte restante" : "cortes restantes"}, até ${perVideo(account)} por vídeo ou live.`)}
      </span>
      <a href={PLANS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
        <Crown className="size-3.5" /> Assinar o Pro
      </a>
    </div>
  );
}

/** "Kortes 1.0.7": the installed app's version (from the launcher, through the backend). */
export function DesktopVersion({ className }: { className?: string }) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/desktop/version", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { version?: string } | null) => setVersion(data?.version || null))
      .catch(() => setVersion(null));
  }, []);
  if (!version) return null;
  return <span className={cn("text-xs tabular-nums text-muted-foreground", className)}>Kortes {version}</span>;
}
