"use client";
import { useRef, useState, type ReactNode } from "react";
import {
  AlignCenter,
  Bookmark,
  Captions,
  Crop,
  Highlighter,
  Info,
  Palette,
  Play,
  Plus,
  RotateCcw,
  ScanFace,
  Trash2,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WebcamRegionPicker } from "@/components/webcam-region-picker";
import {
  DEFAULT_EFFECTS,
  clamp,
  isGameplay,
  replaceWords,
  resizeWebcam,
  uid,
  type EditDocument,
  type CaptionStyle,
  type EditorState,
} from "@/lib/editor/document";
import { cn } from "@/lib/utils";
import { Field, Panel, Range, Section } from "./studio-ui";
export type InspectorTab = "captions" | "framing" | "audio" | "effects";

const TABS = [
  ["captions", "Legendas", Captions],
  ["framing", "Enquadramento", Crop],
  ["audio", "Áudio", Volume2],
  ["effects", "Efeitos", Palette],
] as const;

function ColorField({
  label,
  inputLabel,
  value,
  onChange,
}: {
  label: string;
  inputLabel: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <div className="flex h-9 items-center gap-2 rounded-md border bg-transparent pl-1.5 pr-2 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <input
          aria-label={inputLabel}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="size-6 shrink-0 cursor-pointer rounded border-0 ring-1 ring-border bg-transparent p-0 outline-none [&::-moz-color-swatch]:rounded [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
        />
        <span className="font-mono text-xs uppercase text-muted-foreground">
          {value}
        </span>
      </div>
    </Field>
  );
}

function SwitchRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

interface Props {
  doc: EditDocument;
  asset: EditorState;
  tab: InspectorTab;
  setTab: (tab: InspectorTab) => void;
  time: number;
  seek: (value: number) => void;
  update: (change: (doc: EditDocument) => EditDocument, group?: string) => void;
  applyAll: (style: CaptionStyle) => Promise<void>;
  /** The clip's source cut, for marking the webcam on real frames. */
  mediaUrl: string;
}
export function Inspector({
  doc,
  asset,
  tab,
  setTab,
  time,
  seek,
  update,
  applyAll,
  mediaUrl,
}: Props) {
  const scriptWords = useRef(doc.words);
  const [script, setScript] = useState<string | null>(null),
    [applying, setApplying] = useState(false),
    [pickerOpen, setPickerOpen] = useState(false);
  const landscape = asset.width / Math.max(1, asset.height) > 1.2,
    gameplay = isGameplay(doc.framing);
  const layoutValue = !gameplay
    ? "single"
    : doc.framing.layout === "float"
      ? "float"
      : doc.framing.camPosition === "bottom"
        ? "game_top"
        : "cam_top";
  const enterGameplay = (variant: "cam_top" | "game_top" | "float" = "cam_top") => {
    const layout = variant === "float" ? "float" : "gameplay";
    const camPosition: "top" | "bottom" = variant === "game_top" ? "bottom" : "top";
    const known = doc.framing.webcam ?? asset.gameplay?.webcam;
    if (known) {
      // The clip's own game cut fits when the layout family matches; the
      // floating layout cuts the game narrower, so others start centred.
      const sameFamily = (asset.gameplay?.layout ?? "gameplay") === layout;
      const game = asset.gameplay && sameFamily ? asset.gameplay : { x: 0.5, y: 0.5, zoom: asset.gameplay?.zoom ?? 1 };
      update((d) => ({
        ...d,
        framing: {
          ...d.framing,
          x: game.x,
          y: game.y,
          zoom: game.zoom,
          layout,
          camPosition,
          webcam: d.framing.webcam ?? known,
        },
      }));
      return;
    }
    // Nothing detected for this clip: start bottom-left, where most
    // streamers keep the camera, and let the user mark it on a real frame.
    const w = 0.26,
      h = Math.min(0.9, (w * asset.width) / asset.height / (1080 / 768));
    update((d) => ({
      ...d,
      framing: {
        ...d.framing,
        x: 0.5,
        y: 0.5,
        zoom: 1,
        layout,
        camPosition,
        webcam: { x: 0.02, y: Math.max(0, 0.98 - h), w, h },
      },
    }));
    setPickerOpen(true);
  };
  const caption = (change: Partial<CaptionStyle>, group = "caption-style") =>
    update((d) => ({ ...d, captions: { ...d.captions, ...change } }), group);
  return (
    <Panel
      aria-label="Ferramentas de edição"
      className="md:sticky md:top-4 xl:col-start-3"
    >
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as InspectorTab)}
        className="gap-0"
      >
        <div className="border-b p-2">
          <TabsList className="grid w-full grid-cols-4 group-data-[orientation=horizontal]/tabs:h-auto">
            {TABS.map(([id, label, Icon]) => (
              <TabsTrigger
                key={id}
                value={id}
                className="h-auto flex-col gap-1 py-2 text-xs"
              >
                <Icon />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <div className="md:max-h-[calc(100dvh-250px)] md:overflow-y-auto">
          <TabsContent value="captions" className="space-y-6 p-4">
            <Section
              title="Estilo da legenda"
              description="Escolha um visual e ajuste os detalhes abaixo."
              action={
                <Switch
                  aria-label="Exibir legendas"
                  checked={doc.captions.enabled}
                  onCheckedChange={(enabled) => caption({ enabled })}
                />
              }
            >
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["Limpo", false, "#FFFFFF"],
                    ["Destaque", true, "#FACC15"],
                    ["Pop", true, "#A3E635"],
                  ] as const
                ).map(([name, background, accent]) => {
                  const active =
                    doc.captions.background === background &&
                    doc.captions.accent.toUpperCase() === accent;
                  return (
                    <button
                      key={name}
                      aria-pressed={active}
                      className={cn(
                        "rounded-lg border p-1.5 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        active && "border-primary ring-1 ring-primary",
                      )}
                      onClick={() => caption({ background, accent })}
                    >
                      <span className="flex h-10 items-center justify-center rounded-md bg-stone-900 text-xs font-bold text-white">
                        <span
                          className={cn(
                            "px-1",
                            background && "rounded-sm bg-black/60",
                          )}
                        >
                          Sua <span style={{ color: accent }}>história</span>
                        </span>
                      </span>
                      <span className="block px-0.5 pt-1.5 text-xs font-medium">
                        {name}
                      </span>
                    </button>
                  );
                })}
              </div>
              <Field label="Fonte">
                <Select
                  value={doc.captions.font}
                  onValueChange={(font) =>
                    caption({ font: font as CaptionStyle["font"] })
                  }
                >
                  <SelectTrigger aria-label="Fonte das legendas" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TikTokSans-Regular">TikTok Sans</SelectItem>
                    <SelectItem value="Poppins-ExtraBold">
                      Poppins Extra Bold
                    </SelectItem>
                    <SelectItem value="THEBOLDFONT">The Bold Font</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Range
                label="Tamanho da legenda"
                value={doc.captions.size}
                min={20}
                max={100}
                onChange={(size) => caption({ size })}
              />
              <Range
                label="Posição vertical da legenda"
                value={doc.captions.y * 100}
                min={10}
                max={90}
                unit="%"
                onChange={(y) => caption({ y: y / 100 })}
              />
              <div className="grid grid-cols-2 gap-3">
                <ColorField
                  label="Texto"
                  inputLabel="Cor do texto da legenda"
                  value={doc.captions.color}
                  onChange={(color) => caption({ color })}
                />
                <ColorField
                  label="Destaque"
                  inputLabel="Cor do destaque"
                  value={doc.captions.accent}
                  onChange={(accent) => caption({ accent })}
                />
              </div>
              <SwitchRow
                id="caption-background"
                label="Fundo do texto"
                checked={doc.captions.background}
                onChange={(background) => caption({ background })}
              />
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm font-normal">Palavras por legenda</Label>
                <Select
                  value={String(doc.captions.wordsPerLine)}
                  onValueChange={(n) => caption({ wordsPerLine: Number(n) })}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="Palavras por legenda"
                    className="w-16 tabular-nums"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    try {
                      localStorage.setItem(
                        "supoclip-caption-style",
                        JSON.stringify(doc.captions),
                      );
                      toast.success("Estilo da legenda salvo");
                    } catch {
                      toast.error("Não foi possível salvar o estilo neste dispositivo");
                    }
                  }}
                >
                  <Bookmark />
                  Salvar estilo
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    try {
                      const style = JSON.parse(
                        localStorage.getItem("supoclip-caption-style") ||
                          "null",
                      );
                      if (style?.font && style?.size) caption(style);
                      else toast.info("Salve um estilo primeiro");
                    } catch {
                      toast.error("Não foi possível carregar o estilo salvo");
                    }
                  }}
                >
                  Carregar estilo
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="col-span-2"
                  disabled={applying}
                  onClick={async () => {
                    setApplying(true);
                    try {
                      await applyAll(doc.captions);
                    } finally {
                      setApplying(false);
                    }
                  }}
                >
                  {applying ? "Aplicando…" : "Aplicar a todos os clipes"}
                </Button>
              </div>
            </Section>
            <Separator />
            <Section
              title={
                <>
                  Transcrição{" "}
                  <span className="font-normal text-muted-foreground">
                    · {doc.words.length} palavras
                  </span>
                </>
              }
              description="Corrija uma palavra sem alterar sua sincronização. Clique em reproduzir para ouvir no contexto."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    scriptWords.current = doc.words;
                    setScript(
                      script === null
                        ? doc.words.map((w) => w.text).join(" ")
                        : null,
                    );
                  }}
                >
                  {script === null ? "Editar roteiro" : "Fechar roteiro"}
                </Button>
              }
            >
              {script !== null && (
                <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
                  <Textarea
                    className="min-h-24 bg-background text-sm"
                    aria-label="Texto da legenda"
                    value={script}
                    onChange={(e) => {
                      const text = e.target.value;
                      setScript(text);
                      try {
                        update(
                          (d) => ({
                            ...d,
                            words: replaceWords(
                              scriptWords.current,
                              text,
                              asset.duration,
                            ),
                          }),
                          "script",
                        );
                      } catch (error) {
                        toast.error((error as Error).message);
                      }
                    }}
                  />
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      Palavras existentes mantêm sua sincronização. Revise o tempo
                      das palavras inseridas.
                    </p>
                    <Button
                      size="sm"
                      onClick={() => {
                        try {
                          update((d) => ({
                            ...d,
                            words: replaceWords(
                              scriptWords.current,
                              script,
                              asset.duration,
                            ),
                          }));
                          setScript(null);
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      Aplicar roteiro
                    </Button>
                  </div>
                </div>
              )}
              <ol className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-1">
                {doc.words.map((word, i) => {
                  const current = time >= word.start && time < word.end;
                  return (
                    <li
                      key={word.id}
                      className={cn(
                        "group grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-1 rounded-md py-1 pr-1 transition-colors hover:bg-accent/60",
                        current && "bg-accent",
                      )}
                    >
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Ouvir palavra ${i + 1}`}
                        title="Ouvir palavra"
                        onClick={() => seek(word.start)}
                        className="size-7 text-muted-foreground"
                      >
                        <Play className="size-3" />
                      </Button>
                      <input
                        className="h-7 min-w-0 rounded-sm bg-transparent px-1.5 text-sm outline-none focus:bg-background focus:ring-2 focus:ring-ring/50"
                        aria-label={`Palavra ${i + 1}`}
                        maxLength={120}
                        value={word.text}
                        onChange={(e) =>
                          update(
                            (d) => ({
                              ...d,
                              words: d.words.map((w) =>
                                w.id === word.id
                                   ? { ...w, text: e.target.value }
                                   : w,
                              ),
                            }),
                            `word-${word.id}`,
                          )
                        }
                      />
                      <span className="flex items-center">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Destacar palavra ${i + 1}`}
                          aria-pressed={word.highlight}
                          className={cn(
                            "size-7",
                            word.highlight
                              ? "bg-yellow-100 text-yellow-800 hover:bg-yellow-200"
                              : "text-muted-foreground",
                          )}
                          onClick={() =>
                            update((d) => ({
                              ...d,
                              words: d.words.map((w) =>
                                w.id === word.id
                                  ? { ...w, highlight: !w.highlight }
                                  : w,
                              ),
                            }))
                          }
                        >
                          <Highlighter className="size-3.5" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Excluir palavra ${i + 1}`}
                          className="size-7 text-muted-foreground hover:text-destructive"
                          onClick={() =>
                            update((d) => ({
                              ...d,
                              words: d.words.filter((w) => w.id !== word.id),
                            }))
                          }
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </span>
                      <div className="col-start-2 col-span-2 flex items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground tabular-nums">
                        <input
                          aria-label={`Início da palavra ${i + 1}`}
                          className="w-14 [appearance:textfield] rounded-sm bg-transparent px-1 outline-none hover:bg-background focus:bg-background focus:ring-2 focus:ring-ring/50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                          type="number"
                          min={0}
                          max={word.end - 0.01}
                          step="0.01"
                          value={Number(word.start.toFixed(2))}
                          onChange={(e) =>
                            update(
                              (d) => ({
                                ...d,
                                words: d.words.map((w) =>
                                  w.id === word.id
                                    ? {
                                        ...w,
                                        start: clamp(
                                          Number(e.target.value),
                                          0,
                                          w.end - 0.01,
                                        ),
                                      }
                                    : w,
                                ),
                              }),
                              `timing-${word.id}`,
                            )
                          }
                        />
                        <span aria-hidden>→</span>
                        <input
                          aria-label={`Fim da palavra ${i + 1}`}
                          className="w-14 [appearance:textfield] rounded-sm bg-transparent px-1 outline-none hover:bg-background focus:bg-background focus:ring-2 focus:ring-ring/50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                          type="number"
                          min={word.start + 0.01}
                          max={asset.duration}
                          step="0.01"
                          value={Number(word.end.toFixed(2))}
                          onChange={(e) =>
                            update(
                              (d) => ({
                                ...d,
                                words: d.words.map((w) =>
                                  w.id === word.id
                                    ? {
                                        ...w,
                                        end: clamp(
                                          Number(e.target.value),
                                          w.start + 0.01,
                                          asset.duration,
                                        ),
                                      }
                                    : w,
                                ),
                              }),
                              `timing-${word.id}`,
                            )
                          }
                        />
                      </div>
                    </li>
                  );
                })}
              </ol>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() =>
                  update((d) => ({
                    ...d,
                    words: [
                      ...d.words,
                      {
                        id: uid(),
                        text: "Nova",
                        start: Math.min(time, asset.duration - 0.1),
                        end: Math.min(asset.duration, time + 0.5),
                        highlight: false,
                      },
                    ].sort((a, b) => a.start - b.start),
                  }))
                }
              >
                <Plus />
                Adicionar palavra no cursor
              </Button>
            </Section>
          </TabsContent>
          <TabsContent value="framing" className="space-y-6 p-4">
            {landscape && (
              <>
                <Section
                  title="Layout"
                  description={
                    layoutValue === "cam_top"
                      ? "A webcam vai em cima e o jogo embaixo, como nos cortes de live."
                      : layoutValue === "game_top"
                        ? "O jogo vai em cima e a reação embaixo: bom quando a jogada é o principal."
                        : layoutValue === "float"
                          ? "O jogo ocupa a tela toda e a webcam flutua no canto, com borda."
                          : "Para vídeos de live com a câmera num canto da tela, escolha um layout com webcam."
                  }
                >
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    aria-label="Layout"
                    className="w-full"
                    value={layoutValue}
                    onValueChange={(layout) => {
                      if (layout === "cam_top" || layout === "game_top" || layout === "float") enterGameplay(layout);
                      else if (layout === "single")
                        update((d) => ({
                          ...d,
                          framing: {
                            ...d.framing,
                            layout: "single",
                            x: 0.5,
                            y: 0.5,
                            zoom: 1,
                          },
                        }));
                    }}
                  >
                    {(
                      [
                        ["single", "Tela cheia"],
                        ["cam_top", "Webcam em cima"],
                        ["game_top", "Jogo em cima"],
                        ["float", "Webcam flutuando"],
                      ] as const
                    ).map(([value, label]) => (
                      <ToggleGroupItem key={value} value={value} className="h-auto flex-1 whitespace-normal py-1.5 text-[11px] leading-tight">
                        {label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Section>
                <Separator />
              </>
            )}
            {gameplay && doc.framing.webcam ? (
              <Section
                title="Webcam"
                description="Arraste a webcam na pré-visualização para movê-la."
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => setPickerOpen(true)}
                >
                  <ScanFace />
                  Marcar webcam no vídeo
                </Button>
                <Range
                  label="Tamanho da área"
                  min={4}
                  max={100}
                  value={doc.framing.webcam.w * 100}
                  unit="%"
                  onChange={(w) =>
                    update(
                      (d) =>
                        d.framing.webcam
                          ? {
                              ...d,
                              framing: {
                                ...d.framing,
                                webcam: resizeWebcam(d.framing.webcam, w / 100),
                              },
                            }
                          : d,
                      "webcam-size",
                    )
                  }
                />
                {asset.gameplay && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full"
                    onClick={() =>
                      update((d) => ({
                        ...d,
                        framing: { ...d.framing, ...asset.gameplay },
                      }))
                    }
                  >
                    <RotateCcw />
                    Voltar ao enquadramento do clipe
                  </Button>
                )}
              </Section>
            ) : (
            <Section
              title="Enquadramento"
              description="Arraste o vídeo na pré-visualização para manter o foco no assunto."
            >
              <Field label="Proporção">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  aria-label="Proporção"
                  className="w-full"
                  value={doc.framing.aspect}
                  onValueChange={(aspect) =>
                    aspect &&
                    update((d) => ({
                      ...d,
                      framing: {
                        ...d.framing,
                        aspect: aspect as EditDocument["framing"]["aspect"],
                      },
                    }))
                  }
                >
                  {(
                    [
                      ["vertical", "9:16", "Vertical"],
                      ["square", "1:1", "Quadrado"],
                      ["original", "Orig", "Original"],
                    ] as const
                  ).map(([value, ratio, label]) => (
                    <ToggleGroupItem
                      key={value}
                      value={value}
                      aria-label={label}
                      className="h-auto flex-1 flex-col gap-0.5 py-2"
                    >
                      <span className="text-sm font-semibold">{ratio}</span>
                      <span className="text-[11px] font-normal text-muted-foreground">
                        {label}
                      </span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              <Field label="Ajuste">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  aria-label="Ajuste"
                  className="w-full"
                  value={doc.framing.fit}
                  onValueChange={(fit) =>
                    fit &&
                    update((d) => ({
                      ...d,
                      framing: {
                        ...d.framing,
                        fit: fit as EditDocument["framing"]["fit"],
                      },
                    }))
                  }
                >
                  <ToggleGroupItem value="cover" className="flex-1 text-xs">
                    Preencher tela
                  </ToggleGroupItem>
                  <ToggleGroupItem value="contain" className="flex-1 text-xs">
                    Ajustar vídeo completo
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
              {doc.framing.fit === "contain" && doc.framing.aspect !== "original" && (
                <Field label="Fundo">
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    aria-label="Fundo"
                    className="w-full"
                    value={doc.framing.background ?? "black"}
                    onValueChange={(background) =>
                      background &&
                      update((d) => ({
                        ...d,
                        framing: { ...d.framing, background: background as "black" | "blur" },
                      }))
                    }
                  >
                    <ToggleGroupItem value="black" className="flex-1 text-xs">
                      Preto
                    </ToggleGroupItem>
                    <ToggleGroupItem value="blur" className="flex-1 text-xs">
                      Borrado
                    </ToggleGroupItem>
                  </ToggleGroup>
                </Field>
              )}
            </Section>
            )}
            <Separator />
            <Section
              title={gameplay ? "Jogo" : "Posição"}
              description={
                gameplay
                  ? "Zoom e posição do jogo na parte de baixo."
                  : undefined
              }
            >
              <Range
                label="Zoom"
                min={1}
                max={3}
                step={0.01}
                value={doc.framing.zoom}
                unit="×"
                onChange={(zoom) =>
                  update(
                    (d) => ({ ...d, framing: { ...d.framing, zoom } }),
                    "zoom",
                  )
                }
              />
              <Range
                label="Posição horizontal"
                min={0}
                max={100}
                value={doc.framing.x * 100}
                unit="%"
                onChange={(x) =>
                  update(
                    (d) => ({ ...d, framing: { ...d.framing, x: x / 100 } }),
                    "position",
                  )
                }
              />
              <Range
                label="Posição vertical"
                min={0}
                max={100}
                value={doc.framing.y * 100}
                unit="%"
                onChange={(y) =>
                  update(
                    (d) => ({ ...d, framing: { ...d.framing, y: y / 100 } }),
                    "position",
                  )
                }
              />
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() =>
                  update((d) => ({
                    ...d,
                    framing: { ...d.framing, x: 0.5, y: 0.5, zoom: 1 },
                  }))
                }
              >
                <AlignCenter />
                {gameplay ? "Centralizar jogo" : "Centralizar assunto"}
              </Button>
            </Section>
            <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
              <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-3xl overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Onde fica a webcam?</DialogTitle>
                  <DialogDescription>
                    A área marcada vai para a parte de cima do clipe e o jogo
                    fica embaixo.
                  </DialogDescription>
                </DialogHeader>
                <WebcamRegionPicker
                  videoSrc={mediaUrl}
                  value={doc.framing.webcam ?? null}
                  onChange={(webcam) =>
                    webcam &&
                    update(
                      (d) => ({
                        ...d,
                        framing: { ...d.framing, layout: "gameplay", webcam },
                      }),
                      "pick-webcam",
                    )
                  }
                />
                <DialogFooter>
                  <Button type="button" onClick={() => setPickerOpen(false)}>
                    Concluir
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </TabsContent>
          <TabsContent value="audio" className="space-y-6 p-4">
            <Section
              title="Áudio"
              description="Alterações de áudio são incluídas na sua exportação."
            >
              {!asset.hasAudio && (
                <Alert>
                  <Info />
                  <AlertDescription>
                    Este clipe não possui faixa de áudio.
                  </AlertDescription>
                </Alert>
              )}
              <Range
                label="Volume"
                value={doc.volume * 100}
                min={0}
                max={200}
                unit="%"
                onChange={(volume) =>
                  update((d) => ({ ...d, volume: volume / 100 }), "volume")
                }
              />
              <SwitchRow
                id="mute-export"
                label="Silenciar áudio na exportação"
                checked={doc.muted}
                onChange={(muted) => update((d) => ({ ...d, muted }))}
              />
              {doc.volume > 1 && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Aumentar áudio muito baixo pode causar distorções nos picos.
                  Ouça antes de exportar.
                </p>
              )}
            </Section>
          </TabsContent>
          <TabsContent value="effects" className="space-y-6 p-4">
            <Section
              title="Efeitos"
              description="Efeitos se aplicam ao vídeo. As legendas continuam nítidas."
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    update((d) => ({ ...d, effects: { ...DEFAULT_EFFECTS } }))
                  }
                >
                  <RotateCcw />
                  Redefinir
                </Button>
              }
            >
              {(
                [
                  ["Brilho", "brightness", 40, 180, 1],
                  ["Contraste", "contrast", 40, 180, 1],
                  ["Saturação", "saturation", 0, 220, 1],
                  ["Desfoque", "blur", 0, 8, 0.1],
                  ["Matiz", "hue", -180, 180, 1],
                ] as const
              ).map(([label, key, min, max, step]) => (
                <Range
                  key={key}
                  label={label}
                  value={doc.effects[key]}
                  min={min}
                  max={max}
                  step={step}
                  onChange={(value) =>
                    update(
                      (d) => ({
                        ...d,
                        effects: { ...d.effects, [key]: value },
                      }),
                      key,
                    )
                  }
                />
              ))}
            </Section>
          </TabsContent>
        </div>
      </Tabs>
    </Panel>
  );
}
