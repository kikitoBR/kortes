"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Loader2, MessageSquare, Plus } from "lucide-react";
import { KortesLoader } from "@/components/kortes-loader";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Kortes Desktop: talk to support. Messages go to the Kortes site (through the
 * local backend, with this PC's license); replies written in the site's panel
 * show up here. A dot on the button marks a reply not seen yet.
 */

type Message = { id: string; author: "customer" | "admin"; body: string; createdAt: string };
type Thread = {
  id: string;
  category: string;
  subject: string;
  status: "open" | "answered" | "closed";
  createdAt: string;
  updatedAt: string;
  messages: Message[];
};

const CATEGORIES = [
  { value: "support", label: "Preciso de ajuda" },
  { value: "bug", label: "Encontrei um erro" },
  { value: "feature", label: "Tenho uma sugestão" },
  { value: "general", label: "Feedback geral" },
];

const STATUS: Record<Thread["status"], string> = {
  open: "Aguardando resposta",
  answered: "Respondida",
  closed: "Encerrada",
};

const SEEN_KEY = "kortes:support-seen";
const POLL_MS = 5 * 60 * 1000;

function lastReplyAt(threads: Thread[]): string {
  let latest = "";
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (message.author === "admin" && message.createdAt > latest) latest = message.createdAt;
    }
  }
  return latest;
}

function readSeen(): string {
  try {
    return window.localStorage.getItem(SEEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeSeen(value: string) {
  try {
    window.localStorage.setItem(SEEN_KEY, value);
  } catch {
    // Without storage the dot comes back on the next start; nothing else breaks.
  }
}

async function call(path: string, init?: RequestInit): Promise<{ threads: Thread[]; id?: string }> {
  const response = await fetch(`/api/desktop/${path}`, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || "Não deu para falar com o suporte agora.");
  return { threads: Array.isArray(data?.threads) ? data.threads : [], id: data?.id };
}

function formatWhen(value: string) {
  return new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function DesktopSupport() {
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "new" | string>("list");
  const [unread, setUnread] = useState(false);
  const [category, setCategory] = useState("support");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [sending, setSending] = useState(false);

  const apply = useCallback((items: Thread[], markSeen: boolean) => {
    setThreads(items);
    const latest = lastReplyAt(items);
    if (markSeen) {
      writeSeen(latest);
      setUnread(false);
    } else {
      setUnread(Boolean(latest) && latest > readSeen());
    }
  }, []);

  const load = useCallback(async (markSeen: boolean) => {
    try {
      const { threads: items } = await call("support");
      setError(null);
      apply(items, markSeen);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apply]);

  // Background check for replies (also when the window comes back into focus).
  useEffect(() => {
    const refresh = () => { if (!document.hidden) void load(false); };
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      void load(true);
      setView((current) => (current === "new" ? current : "list"));
    }
  };

  const send = async () => {
    const text = message.trim();
    if (!text) return;
    setSending(true);
    try {
      const isNew = view === "new";
      const result = isNew
        ? await call("support", { method: "POST", body: JSON.stringify({ category, message: text, contact: contact.trim() }) })
        : await call(`support/${view}/messages`, { method: "POST", body: JSON.stringify({ message: text }) });
      apply(result.threads, true);
      setMessage("");
      if (isNew) {
        toast.success("Mensagem enviada. A resposta aparece aqui.");
        setView(result.id ?? "list");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const current = threads?.find((thread) => thread.id === view) ?? null;

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetTrigger asChild>
        <Button
          size="icon"
          aria-label={unread ? "Suporte (resposta nova)" : "Suporte e feedback"}
          title="Suporte e feedback"
          className="fixed bottom-5 right-5 z-50 h-11 w-11 rounded-full shadow-lg"
        >
          <MessageSquare className="h-5 w-5" />
          {unread && <span aria-hidden className="absolute right-0.5 top-0.5 size-3 rounded-full border-2 border-background bg-brand" />}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Suporte e feedback</SheetTitle>
          <SheetDescription>Fale com a equipe do Kortes. As respostas chegam aqui.</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {view === "new" ? (
            <div className="space-y-3">
              <button type="button" onClick={() => setView("list")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4" /> Conversas
              </button>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Textarea
                placeholder="Conte o que aconteceu ou o que você gostaria. Se for um erro, diga o que estava fazendo."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={7}
                maxLength={4000}
              />
              <Input
                placeholder="E-mail ou WhatsApp (opcional)"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                maxLength={200}
              />
              <Button className="w-full" disabled={!message.trim() || sending} onClick={send}>
                {sending ? <Loader2 className="size-4 animate-spin" /> : "Enviar"}
              </Button>
            </div>
          ) : current ? (
            <div className="space-y-3">
              <button type="button" onClick={() => setView("list")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4" /> Conversas
              </button>
              <div>
                <h3 className="font-semibold leading-snug">{current.subject}</h3>
                <p className="text-xs text-muted-foreground">{STATUS[current.status]}</p>
              </div>
              <div className="space-y-2">
                {current.messages.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      "max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm",
                      m.author === "admin" ? "bg-brand-soft" : "ml-auto border bg-background",
                    )}
                  >
                    {m.body}
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      {m.author === "admin" ? "Equipe Kortes" : "Você"} · {formatWhen(m.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Button className="w-full" onClick={() => { setMessage(""); setView("new"); }}>
                <Plus className="size-4" /> Nova mensagem
              </Button>
              {error && <p className="text-sm text-destructive">{error}</p>}
              {threads === null && !error && <KortesLoader size={48} className="mx-auto" />}
              {threads?.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Nenhuma conversa ainda. Dúvidas, erros e sugestões são bem-vindos.
                </p>
              )}
              <ul className="space-y-2">
                {threads?.map((thread) => {
                  const last = thread.messages[thread.messages.length - 1];
                  return (
                    <li key={thread.id}>
                      <button
                        type="button"
                        onClick={() => { setMessage(""); setView(thread.id); }}
                        className="w-full rounded-xl border p-3 text-left transition-colors hover:border-brand"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium leading-snug">{thread.subject}</span>
                          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", thread.status === "answered" ? "bg-brand text-white" : "bg-muted text-muted-foreground")}>
                            {STATUS[thread.status]}
                          </span>
                        </div>
                        {last && (
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {last.author === "admin" ? "Equipe Kortes: " : "Você: "}{last.body}
                          </p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        {current && (
          <div className="space-y-2 border-t p-4">
            <Textarea
              placeholder={current.status === "closed" ? "Escreva para reabrir a conversa" : "Responder"}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              maxLength={4000}
            />
            <Button className="w-full" disabled={!message.trim() || sending} onClick={send}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : "Enviar"}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
