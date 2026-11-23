"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Download, ImageIcon, Loader2, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { KortesLoader } from "@/components/kortes-loader";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { downloadBlob } from "@/lib/clip-actions";
import { parseApiError, formatSupportMessage } from "@/lib/api-error";

interface ExtraClip {
  id: string;
  filename: string;
  duration: number;
  clip_order: number;
}

const COVER_MAX_TEXT = 60;

const fileStem = (filename: string) => filename.replace(/\.[^.]+$/, "");

async function readError(response: Response, fallback: string) {
  return formatSupportMessage(await parseApiError(response, fallback));
}

/** Cover (thumbnail) generator: best frame picked by the server, editable text and frame. */
export function ClipCoverButton({ taskId, clip }: { taskId: string; clip: ExtraClip }) {
  const base = `/api/tasks/${taskId}/clips/${clip.id}/cover`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [time, setTime] = useState<number | null>(null);
  const [sliderTime, setSliderTime] = useState(0);
  const [suggesting, setSuggesting] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textTouched = useRef(false);

  const suggest = useCallback(async () => {
    setSuggesting(true);
    setError(null);
    try {
      const response = await fetch(`${base}/suggest`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "Não foi possível analisar o clipe."));
      const data = (await response.json()) as { time: number; text: string };
      setTime(data.time);
      setSliderTime(data.time);
      if (!textTouched.current) {
        setText(data.text);
        setPreviewText(data.text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível analisar o clipe.");
    } finally {
      setSuggesting(false);
    }
  }, [base]);

  useEffect(() => {
    if (open && time === null && !suggesting && !error) void suggest();
  }, [open, time, suggesting, error, suggest]);

  // Re-render the preview a moment after the user stops typing.
  useEffect(() => {
    const id = window.setTimeout(() => setPreviewText(text), 450);
    return () => window.clearTimeout(id);
  }, [text]);

  const previewUrl =
    time === null ? null : `${base}?${new URLSearchParams({ text: previewText, t: time.toFixed(2) }).toString()}`;

  useEffect(() => {
    if (previewUrl) setImageLoading(true);
  }, [previewUrl]);

  const download = async () => {
    if (!previewUrl) return;
    setDownloading(true);
    try {
      const response = await fetch(previewUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "Não foi possível baixar a capa."));
      downloadBlob(await response.blob(), `${fileStem(clip.filename)}_capa.jpg`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível baixar a capa.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <ImageIcon className="size-4" />
        Capa
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Capa do clipe {clip.clip_order}</DialogTitle>
            <DialogDescription>
              Escolhemos o quadro mais forte do clipe. Ajuste o texto e o momento, e baixe para usar no Instagram, TikTok e YouTube.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 sm:grid-cols-[minmax(0,240px)_1fr]">
            <div className="relative mx-auto aspect-[9/16] w-full max-w-[240px] overflow-hidden rounded-xl bg-muted">
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt={`Capa do clipe ${clip.clip_order}`}
                  className="size-full object-contain"
                  onLoad={() => setImageLoading(false)}
                  onError={() => {
                    setImageLoading(false);
                    setError("Não foi possível gerar a capa.");
                  }}
                />
              ) : null}
              {(suggesting || imageLoading) && (
                <div className="absolute inset-0 grid place-items-center bg-background/40">
                  <KortesLoader size={48} />
                </div>
              )}
            </div>
            <div className="space-y-5">
              <div className="space-y-1.5">
                <label htmlFor={`cover-text-${clip.id}`} className="text-sm font-medium">Texto da capa</label>
                <Input
                  id={`cover-text-${clip.id}`}
                  value={text}
                  maxLength={COVER_MAX_TEXT}
                  placeholder="Ex.: ELE NÃO ESPERAVA ISSO"
                  onChange={(event) => {
                    textTouched.current = true;
                    setText(event.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">2 a 6 palavras fortes funcionam melhor. Deixe vazio para uma capa sem texto.</p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">Momento do clipe</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{sliderTime.toFixed(1)}s</span>
                </div>
                <Slider
                  aria-label="Momento do clipe"
                  min={0}
                  max={Math.max(0.1, clip.duration - 0.1)}
                  step={0.1}
                  value={[sliderTime]}
                  disabled={time === null}
                  onValueChange={([value]) => setSliderTime(value)}
                  onValueCommit={([value]) => setTime(value)}
                />
                <Button type="button" variant="ghost" size="sm" disabled={suggesting} onClick={() => void suggest()}>
                  <Wand2 className="size-4" />
                  Escolher o melhor quadro
                </Button>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="button" onClick={() => void download()} disabled={!previewUrl || downloading}>
                {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                Baixar capa
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface PostTexts {
  tiktok: string;
  instagram: string;
  youtube: { title: string; description: string };
}

// Keeps texts while the page is open, so reopening a clip doesn't spend a new AI call.
const postTextsCache = new Map<string, PostTexts>();

function CopyField({ label, value, onChange, rows = 4 }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copiado`);
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void copy()} disabled={!value}>
          <Copy className="size-4" />
          Copiar
        </Button>
      </div>
      <Textarea value={value} rows={rows} onChange={(event) => onChange(event.target.value)} aria-label={label} />
    </div>
  );
}

/** AI-written post copy for TikTok, Instagram and YouTube Shorts, editable and copyable. */
export function ClipPostTextsButton({ taskId, clip }: { taskId: string; clip: ExtraClip }) {
  const cacheKey = `${taskId}:${clip.id}`;
  const [open, setOpen] = useState(false);
  const [texts, setTexts] = useState<PostTexts | null>(() => postTextsCache.get(cacheKey) ?? null);
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTexts(postTextsCache.get(cacheKey) ?? null);
  }, [cacheKey]);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${taskId}/clips/${clip.id}/post-texts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: instructions.trim() || null }),
      });
      if (!response.ok) throw new Error(await readError(response, "Não foi possível escrever os textos agora."));
      const data = (await response.json()) as PostTexts;
      postTextsCache.set(cacheKey, data);
      setTexts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível escrever os textos agora.");
    } finally {
      setLoading(false);
    }
  }, [taskId, clip.id, instructions, cacheKey]);

  useEffect(() => {
    if (open && !texts && !loading && !error) void generate();
  }, [open, texts, loading, error, generate]);

  const update = (patch: (current: PostTexts) => PostTexts) =>
    setTexts((current) => {
      if (!current) return current;
      const next = patch(current);
      postTextsCache.set(cacheKey, next);
      return next;
    });

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Sparkles className="size-4" />
        Textos do post
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Textos para postar o clipe {clip.clip_order}</DialogTitle>
            <DialogDescription>
              Legenda pronta para TikTok, Instagram e YouTube Shorts, escrita a partir do que é falado no clipe. Edite à vontade antes de copiar.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={instructions}
              maxLength={300}
              placeholder="Pedido opcional (ex.: tom mais engraçado, citar o nome do jogo)"
              onChange={(event) => setInstructions(event.target.value)}
              aria-label="Pedido para a IA"
            />
            <Button type="button" variant="outline" onClick={() => void generate()} disabled={loading} className="shrink-0">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {texts ? "Gerar de novo" : "Gerar"}
            </Button>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {loading && !texts ? (
            <div className="grid place-items-center py-10 text-sm text-muted-foreground">
              <KortesLoader size={48} className="mb-2 text-foreground" />
              Escrevendo os textos…
            </div>
          ) : texts ? (
            <div className="space-y-5">
              <CopyField label="TikTok" value={texts.tiktok} rows={3} onChange={(tiktok) => update((t) => ({ ...t, tiktok }))} />
              <CopyField label="Instagram" value={texts.instagram} rows={6} onChange={(instagram) => update((t) => ({ ...t, instagram }))} />
              <div className="space-y-3 rounded-xl border p-3">
                <p className="text-sm font-semibold">YouTube Shorts</p>
                <CopyField label="Título" value={texts.youtube.title} rows={2} onChange={(title) => update((t) => ({ ...t, youtube: { ...t.youtube, title } }))} />
                <CopyField label="Descrição" value={texts.youtube.description} rows={4} onChange={(description) => update((t) => ({ ...t, youtube: { ...t.youtube, description } }))} />
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

const ADJUST_EXAMPLES = [
  "Começa 3 s antes",
  "Termina depois da reação",
  "Troca o título por algo mais curioso",
  "Tira o gancho do começo",
];

/** Change a ready clip by asking for it in plain words; the server renders it again. */
export function ClipAdjustButton({
  taskId,
  clip,
  onAdjusted,
}: {
  taskId: string;
  clip: ExtraClip;
  onAdjusted: () => void | Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const request = instructions.trim();
    if (!request || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${taskId}/clips/${clip.id}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: request }),
      });
      if (!response.ok) throw new Error(await readError(response, "Não foi possível ajustar o clipe."));
      const data = (await response.json()) as { reply?: string };
      await onAdjusted();
      toast.success(data.reply || "Pronto, o clipe foi refeito.");
      setInstructions("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível ajustar o clipe.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Wand2 className="size-4" />
        Ajustar com IA
      </Button>
      <Dialog open={open} onOpenChange={(next) => !loading && setOpen(next)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Ajustar o clipe {clip.clip_order}</DialogTitle>
            <DialogDescription>
              Diga o que mudar e o clipe é montado de novo a partir do vídeo original.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={instructions}
            maxLength={500}
            rows={3}
            autoFocus
            disabled={loading}
            placeholder="Ex.: começa 3 s antes e troca o título por algo mais curioso"
            onChange={(event) => setInstructions(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
            }}
            aria-label="O que mudar no clipe"
          />
          <div className="flex flex-wrap gap-1.5">
            {ADJUST_EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                disabled={loading}
                onClick={() => setInstructions(example)}
                className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {example}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {loading ? "Refazendo o clipe. Leva cerca de 1 a 2 minutos." : "O clipe atual é substituído pelo novo."}
            </p>
            <Button type="button" onClick={() => void submit()} disabled={loading || !instructions.trim()}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
              {loading ? "Ajustando…" : "Ajustar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
