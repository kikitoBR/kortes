"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { liveEmbedUrls, type LiveEmbed } from "@/lib/live-links";
import { cn } from "@/lib/utils";

const PLATFORM_NAME: Record<LiveEmbed["platform"], string> = {
  youtube: "YouTube",
  twitch: "Twitch",
  kick: "Kick",
};
const STORAGE_KEY = "kortes-live-watch-open";

/** The live itself (official player, muted) and its chat, beside the clips being cut. */
export function LiveWatch({ embed }: { embed: LiveEmbed }) {
  const [host, setHost] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);

  useEffect(() => {
    setHost(window.location.hostname);
    try {
      setOpen(localStorage.getItem(STORAGE_KEY) !== "closed");
    } catch {
      /* private mode: keep it open */
    }
  }, []);

  const toggle = () => {
    setOpen((value) => {
      try {
        localStorage.setItem(STORAGE_KEY, value ? "closed" : "open");
      } catch {
        /* ignore */
      }
      return !value;
    });
  };

  const urls = host ? liveEmbedUrls(embed, host) : null;
  if (!urls) return null;
  const name = PLATFORM_NAME[embed.platform];

  return (
    <section className="overflow-hidden rounded-2xl border bg-background" aria-label="Live e chat">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <span className="size-2 rounded-full bg-red-600 motion-safe:animate-pulse" />
          Assistindo a live
          <span className="font-normal text-muted-foreground">· {name}</span>
        </p>
        <div className="flex items-center gap-1">
          {open && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setChatOpen((value) => !value)} aria-pressed={chatOpen}>
              <MessageSquare className="size-4" />
              <span className="hidden sm:inline">{chatOpen ? "Esconder chat" : "Mostrar chat"}</span>
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" asChild>
            <a href={urls.page} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              <span className="hidden sm:inline">Abrir na {name}</span>
            </a>
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={toggle} aria-expanded={open}>
            <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
            {open ? "Recolher" : "Mostrar"}
          </Button>
        </div>
      </div>
      {open && (
        <div className={cn("grid", chatOpen && "lg:grid-cols-[minmax(0,1fr)_340px]")}>
          <div className="aspect-video w-full bg-black">
            <iframe
              src={urls.player}
              title={`Live na ${name}`}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              className="size-full"
            />
          </div>
          {chatOpen && (
            <div className="flex h-[380px] flex-col border-t lg:h-auto lg:border-l lg:border-t-0">
              <iframe src={urls.chat} title={`Chat da live na ${name}`} className="min-h-0 w-full flex-1" />
              <a
                href={urls.page}
                target="_blank"
                rel="noreferrer"
                className="border-t px-3 py-1.5 text-center text-[11px] text-muted-foreground hover:text-foreground"
              >
                O chat não carregou? Abrir na {name}
              </a>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
