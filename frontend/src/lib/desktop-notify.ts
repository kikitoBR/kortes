// Kortes Desktop: a Windows notice when a cut is ready and the app is not in front
// (Configurações → "Avisar quando um corte ficar pronto", on by default).

import { isDesktop } from "@/lib/edition";
import { normalizeVideoDefaults } from "@/lib/video-defaults";

let enabled: Promise<boolean> | null = null;

function notifyEnabled(): Promise<boolean> {
  enabled ??= fetch("/api/preferences", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => normalizeVideoDefaults(data?.videoDefaults).notifyDesktop)
    .catch(() => true);
  return enabled;
}

/** Configurações changed the switch: read it again next time. */
export function forgetNotifySetting() {
  enabled = null;
}

export async function notifyClipReady(clip: { hook_title?: string | null } | null | undefined) {
  if (!isDesktop || typeof Notification === "undefined" || document.hasFocus()) return;
  if (!(await notifyEnabled())) return;
  if (Notification.permission === "default") await Notification.requestPermission().catch(() => undefined);
  if (Notification.permission !== "granted") return;
  const notice = new Notification("Corte pronto no Kortes", {
    body: clip?.hook_title?.trim() || "Um corte novo está pronto para ver.",
    icon: "/logo.png",
  });
  notice.onclick = () => window.focus();
}
