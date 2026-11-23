"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { DesktopSetup } from "@/components/desktop/desktop-setup";
import { Button } from "@/components/ui/button";
import { isDesktop } from "@/lib/edition";

/** Kortes Desktop first run: activate the license, connect AssemblyAI (or use Whisper). */
export default function SetupPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  if (!isDesktop) {
    router.replace("/");
    return null;
  }

  return (
    <main className="min-h-dvh bg-canvas px-4 py-10 sm:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center gap-2 font-display text-lg font-bold tracking-tight">
          <Image src="/logo.png" alt="" width={28} height={28} className="size-7" priority />
          Kortes
        </div>
        <h1 className="mt-8 font-display text-3xl font-bold tracking-tight">Vamos deixar tudo pronto</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Dois passos rápidos: ative sua licença e escolha como o Kortes vai transcrever seus vídeos.
        </p>
        <div className="mt-8">
          <DesktopSetup onReadyChange={setReady} />
        </div>
        <div className="mt-8 flex items-center justify-end gap-3">
          {!ready ? <p className="text-sm text-muted-foreground">Ative a licença para continuar.</p> : null}
          <Button size="lg" disabled={!ready} onClick={() => router.push("/")}>
            Começar a criar <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    </main>
  );
}
