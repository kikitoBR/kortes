"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, ExternalLink, KeyRound, Loader2, Mic } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type LicenseInfo = {
  name: string;
  status: string;
  expires_at: string | null;
  monthly_tokens: number;
  used_tokens: number;
  devices: number;
  max_devices: number;
};

export type DesktopSetupState = {
  license: { configured: boolean; info?: LicenseInfo; error?: { code: string; message: string } };
  assemblyai: { configured: boolean };
  transcription: "assemblyai" | "whisper";
  whisper_fallback: boolean;
  ready: boolean;
};

const ASSEMBLYAI_SIGNUP_URL = "https://www.assemblyai.com/dashboard/signup";
const ASSEMBLYAI_KEYS_URL = "https://www.assemblyai.com/app/api-keys";

let readyCache: boolean | null = null;

/** Whether the license is active (cached for the page's lifetime; the setup page refreshes it). */
export async function isDesktopReady(): Promise<boolean> {
  if (readyCache !== null) return readyCache;
  try {
    const state = await fetchSetup();
    readyCache = state.ready;
  } catch {
    // The backend may still be starting: do not lock the person out of the app.
    return true;
  }
  return readyCache;
}

async function fetchSetup(): Promise<DesktopSetupState> {
  const response = await fetch("/api/desktop/setup", { cache: "no-store" });
  if (!response.ok) throw new Error(`setup ${response.status}`);
  return (await response.json()) as DesktopSetupState;
}

async function send(path: string, method: "POST" | "DELETE", key?: string) {
  const response = await fetch(`/api/desktop/${path}`, {
    method,
    headers: key ? { "Content-Type": "application/json" } : undefined,
    body: key ? JSON.stringify({ key }) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as { detail?: string }).detail || "Não deu certo. Tente de novo.");
  }
  return data;
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(".0", "")} mi`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} mil`;
  return String(value);
}

function formatDate(value: string | null) {
  if (!value) return "Sem vencimento";
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return `Vence em ${date.toLocaleDateString("pt-BR")}`;
}

/** The license and AssemblyAI cards, used by the first-run page and by Configurações. */
export function DesktopSetup({ onReadyChange }: { onReadyChange?: (ready: boolean) => void }) {
  const [state, setState] = useState<DesktopSetupState | null>(null);
  const [loadError, setLoadError] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await fetchSetup();
      readyCache = next.ready;
      setState(next);
      setLoadError(false);
      onReadyChange?.(next.ready);
    } catch {
      setLoadError(true);
    }
  }, [onReadyChange]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loadError) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border bg-background p-5 text-sm text-muted-foreground">
        <AlertCircle className="size-4" />
        O Kortes ainda está iniciando.
        <Button variant="link" className="h-auto p-0" onClick={() => void reload()}>Tentar de novo</Button>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border bg-background p-5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Carregando…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <LicenseCard state={state} onChange={reload} />
      <TranscriptionCard state={state} onChange={reload} />
    </div>
  );
}

function Card({ icon, title, description, children }: {
  icon: React.ReactNode; title: string; description: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-background">
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">{icon}</span>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="space-y-4 p-5">{children}</div>
    </section>
  );
}

function KeyForm({ placeholder, buttonLabel, onSubmit }: {
  placeholder: string; buttonLabel: string; onSubmit: (key: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(value.trim());
      setValue("");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Não deu certo. Tente de novo.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="font-mono"
        />
        <Button type="submit" disabled={saving || !value.trim()} className="shrink-0">
          {saving ? <><Loader2 className="size-4 animate-spin" /> Conferindo…</> : buttonLabel}
        </Button>
      </div>
      {error ? (
        <p className="flex items-start gap-1.5 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</p>
      ) : null}
    </form>
  );
}

function LicenseCard({ state, onChange }: { state: DesktopSetupState; onChange: () => Promise<void> }) {
  const [replacing, setReplacing] = useState(false);
  const info = state.license.info;
  const pct = info && info.monthly_tokens > 0 ? Math.min(100, (100 * info.used_tokens) / info.monthly_tokens) : 0;

  const activate = async (key: string) => {
    await send("license", "POST", key);
    setReplacing(false);
    await onChange();
  };

  return (
    <Card
      icon={<KeyRound className="size-4" />}
      title="Licença do Kortes"
      description="A licença libera a IA que escolhe os melhores momentos dos seus vídeos."
    >
      {info && !replacing ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
              <Check className="size-3.5" />
            </span>
            <span className="font-medium">Licença ativa</span>
            <span className="text-muted-foreground">· {info.name}</span>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">IA usada neste mês</dt>
              <dd className="tabular-nums">
                {formatTokens(info.used_tokens)} / {info.monthly_tokens > 0 ? formatTokens(info.monthly_tokens) : "sem limite"}
              </dd>
              {info.monthly_tokens > 0 ? (
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                </div>
              ) : null}
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Computadores</dt>
              <dd className="tabular-nums">{info.devices} de {info.max_devices}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Validade</dt>
              <dd>{formatDate(info.expires_at)}</dd>
            </div>
          </dl>
          <Button variant="outline" size="sm" onClick={() => setReplacing(true)}>Trocar licença</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {state.license.error && !replacing ? (
            <p className="flex items-start gap-1.5 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />{state.license.error.message}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Cole a chave de licença que você recebeu na compra. Ela começa com <code className="font-mono">kl_</code>.
          </p>
          <KeyForm placeholder="kl_…" buttonLabel="Ativar" onSubmit={activate} />
          {replacing ? (
            <Button variant="ghost" size="sm" onClick={() => setReplacing(false)}>Cancelar</Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function TranscriptionCard({ state, onChange }: { state: DesktopSetupState; onChange: () => Promise<void> }) {
  const [removing, setRemoving] = useState(false);

  const save = async (key: string) => {
    await send("assemblyai", "POST", key);
    await onChange();
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await send("assemblyai", "DELETE");
      await onChange();
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Card
      icon={<Mic className="size-4" />}
      title="Transcrição"
      description="Transforma a fala do vídeo em texto com o tempo de cada palavra, para a IA e as legendas."
    >
      {state.assemblyai.configured ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
              <Check className="size-3.5" />
            </span>
            <span className="font-medium">AssemblyAI conectada</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Se a chave falhar ou os créditos acabarem, o Kortes transcreve com o Whisper no seu computador, sem parar o vídeo.
          </p>
          <Button variant="outline" size="sm" disabled={removing} onClick={() => void remove()}>
            {removing ? "Removendo…" : "Remover chave e usar só o Whisper"}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Recomendado: com uma chave da <strong className="text-foreground">AssemblyAI</strong> a transcrição é rápida e precisa.
            Sem ela, o Kortes usa o <strong className="text-foreground">Whisper</strong> no seu computador, que é gratuito mas mais lento.
          </p>
          <ol className="space-y-3 text-sm">
            <Step number={1}>
              Crie sua conta na AssemblyAI.{" "}
              <a href={ASSEMBLYAI_SIGNUP_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
                Abrir cadastro <ExternalLink className="size-3" />
              </a>
            </Step>
            <Step number={2}>
              No painel da AssemblyAI, abra <strong>API Keys</strong> e copie a sua chave.{" "}
              <a href={ASSEMBLYAI_KEYS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
                Abrir API Keys <ExternalLink className="size-3" />
              </a>
            </Step>
            <Step number={3}>Cole a chave aqui. O Kortes confere na hora se ela funciona.</Step>
          </ol>
          <KeyForm placeholder="Chave da AssemblyAI" buttonLabel="Salvar" onSubmit={save} />
        </div>
      )}
    </Card>
  );
}

function Step({ number, children }: { number: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold")}>{number}</span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}
