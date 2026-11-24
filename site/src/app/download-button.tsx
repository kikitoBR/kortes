"use client";

import { useEffect, useState } from "react";

/**
 * "Baixar para Windows" on a computer. On a phone the installer is useless, so
 * the same button sends the site to the person's PC instead (share sheet, or
 * the link copied to paste on the computer).
 */
export function DownloadButton({ href, meta }: { href: string; meta?: string }) {
  const [phone, setPhone] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px), (pointer: coarse) and (max-width: 1024px)");
    const sync = () => setPhone(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const send = async () => {
    const url = "https://kortes.com.br";
    try {
      if (navigator.share) {
        await navigator.share({ title: "Kortes", text: "Baixar o Kortes no computador", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // the person closed the share sheet; nothing to do
    }
  };

  if (phone) {
    return (
      <div className="lp-dl">
        <button type="button" className="lp-btn" onClick={send}>Enviar para o meu PC</button>
        <p className="lp-small">
          {copied ? "Link copiado. Abra no computador para baixar." : "O Kortes é um programa para Windows: baixe pelo computador."}
        </p>
      </div>
    );
  }
  return (
    <div className="lp-dl">
      <a className="lp-btn" href={href}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path d="M3 5.5 10.5 4.4v7.1H3zm8.5-1.2L21 3v8.5h-9.5zM3 12.5h7.5v7.1L3 18.5zm8.5 0H21V21l-9.5-1.3z" fill="currentColor" /></svg>
        Baixar para Windows
      </a>
      {meta ? <p className="lp-small">{meta}</p> : null}
    </div>
  );
}
