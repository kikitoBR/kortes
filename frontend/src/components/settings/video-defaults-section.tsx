"use client";

import { useState } from "react";
import { Bell, Clapperboard, FolderOpen, Scissors } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { desktopBridge } from "@/lib/desktop-bridge";
import { isDesktop } from "@/lib/edition";
import { cn } from "@/lib/utils";
import { CLIP_COUNTS, DURATIONS, FRAMINGS, STRICTNESS, type VideoDefaults } from "@/lib/video-defaults";

type Props = {
  value: VideoDefaults;
  onChange: (next: VideoDefaults) => void;
  disabled?: boolean;
};

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
      <div className="space-y-6 p-5">{children}</div>
    </section>
  );
}

/** A row of choices, like the home page's chips. */
function Choices<T extends string | number | null>({ label, options, value, onPick, disabled, hint }: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onPick: (value: T) => void;
  disabled?: boolean;
  hint?: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-sm">{label}</Label>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            disabled={disabled}
            onClick={() => onPick(option.value)}
            className={cn(
              "min-w-14 rounded-xl border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50",
              value === option.value ? "border-foreground bg-accent/50 ring-1 ring-foreground" : "hover:bg-accent/40",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Toggle({ id, title, description, checked, onChange, disabled }: {
  id: string; title: string; description: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label htmlFor={id} className="flex-col items-start gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs font-normal text-muted-foreground">{description}</span>
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/** Configurações → how new videos and lives are cut. */
export function VideoDefaultsSection({ value, onChange, disabled }: Props) {
  const set = <K extends keyof VideoDefaults>(key: K, next: VideoDefaults[K]) => onChange({ ...value, [key]: next });
  const autoCap = isDesktop ? 20 : 10;
  return (
    <Card
      icon={<Scissors className="size-4" />}
      title="Padrões para novos vídeos"
      description="Como a IA corta cada vídeo ou live. A tela inicial já começa com estas escolhas."
    >
      <Choices
        label="Cortes por vídeo"
        options={CLIP_COUNTS}
        value={value.clipCount}
        onPick={(next) => set("clipCount", next)}
        disabled={disabled}
        hint={
          value.clipCount === null
            ? `Automático: cerca de 1 corte a cada 5 minutos de vídeo, até ${autoCap}.`
            : "A IA entrega até essa quantidade, se o vídeo tiver momentos bons o bastante. Lives não têm esse limite."
        }
      />
      <Choices
        label="Exigência da IA"
        options={STRICTNESS.map((s) => ({ value: s.id, label: s.label }))}
        value={value.strictness}
        onPick={(next) => set("strictness", next)}
        disabled={disabled}
        hint={STRICTNESS.find((s) => s.id === value.strictness)?.hint}
      />
      <Choices
        label="Duração dos cortes"
        options={DURATIONS.map((d) => ({ value: d.id, label: `${d.label} · ${d.range}` }))}
        value={value.clipDuration}
        onPick={(next) => set("clipDuration", next)}
        disabled={disabled}
      />
      <div className="space-y-2">
        <Label className="text-sm">Formato</Label>
        <Select value={value.outputFormat} onValueChange={(next) => set("outputFormat", next as VideoDefaults["outputFormat"])} disabled={disabled}>
          <SelectTrigger className="w-full sm:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FRAMINGS.map((framing) => (
              <SelectItem key={framing.id} value={framing.id}>
                {framing.label} · <span className="text-muted-foreground">{framing.hint}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Toggle
        id="title-overlay"
        title="Título no início do corte"
        description="A IA escreve uma chamada que aparece no topo nos primeiros segundos."
        checked={value.titleOverlay}
        onChange={(next) => set("titleOverlay", next)}
        disabled={disabled}
      />
      <Toggle
        id="hook-intro"
        title="Ganho inicial"
        description="O corte abre com a frase mais forte e volta com um efeito de rebobinar."
        checked={value.hookIntro}
        onChange={(next) => set("hookIntro", next)}
        disabled={disabled}
      />
    </Card>
  );
}

/** Kortes Desktop: a copy of every cut in a folder of the customer's PC, and the Windows notice. */
export function DesktopCutsSection({ value, onChange, disabled }: Props) {
  const bridge = desktopBridge();
  const [problem, setProblem] = useState<string | null>(null);

  const pick = async () => {
    setProblem(null);
    const folder = await bridge?.pickFolder(value.exportDir ?? undefined);
    if (folder) onChange({ ...value, exportDir: folder });
  };
  const open = async () => {
    if (!value.exportDir || !bridge) return;
    const reason = await bridge.openFolder(value.exportDir);
    setProblem(reason || null);
  };

  return (
    <Card
      icon={<Clapperboard className="size-4" />}
      title="Seus cortes no computador"
      description="Onde guardar uma cópia de cada corte e como avisar quando ficar pronto."
    >
      <div className="space-y-2">
        <Label className="text-sm">Pasta dos cortes</Label>
        {value.exportDir ? (
          <p className="break-all rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs">{value.exportDir}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Desligado: os cortes ficam só no Kortes. Escolha uma pasta para receber uma cópia de cada corte pronto,
            separada por vídeo.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled || !bridge} onClick={() => void pick()}>
            <FolderOpen className="size-4" /> {value.exportDir ? "Trocar pasta" : "Escolher pasta"}
          </Button>
          {value.exportDir ? (
            <>
              <Button type="button" variant="outline" size="sm" disabled={!bridge} onClick={() => void open()}>
                Abrir pasta
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ ...value, exportDir: null })}>
                Não copiar mais
              </Button>
            </>
          ) : null}
        </div>
        {!bridge ? <p className="text-xs text-muted-foreground">Atualize o Kortes para escolher a pasta.</p> : null}
        {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
      </div>
      <div className="flex items-start gap-3">
        <Bell className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <Toggle
            id="notify-desktop"
            title="Avisar quando um corte ficar pronto"
            description="Um aviso do Windows quando o Kortes não estiver na frente (útil durante uma live)."
            checked={value.notifyDesktop}
            onChange={(next) => onChange({ ...value, notifyDesktop: next })}
            disabled={disabled}
          />
        </div>
      </div>
    </Card>
  );
}
