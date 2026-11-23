"use client";

import { useEffect, useState } from "react";
import { ANNOUNCEMENTS_UPDATED_EVENT, type Announcement } from "@/lib/announcements";
import { isDesktop } from "@/lib/edition";

let pending: Promise<Announcement[] | null> | null = null;

function loadAnnouncements() {
  // Kortes Desktop reads them from the Kortes site, through the local backend.
  pending ??= fetch(isDesktop ? "/api/desktop/announcements" : "/api/announcements", { cache: "no-store" })
    .then(async response => response.ok ? ((await response.json()) as { announcements: Announcement[] }).announcements : null)
    .catch(() => null)
    .finally(() => { pending = null; });
  return pending;
}

export function useAnnouncements() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (document.hidden) return;
      void loadAnnouncements().then(items => { if (!cancelled && items) setAnnouncements(items); });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener(ANNOUNCEMENTS_UPDATED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener(ANNOUNCEMENTS_UPDATED_EVENT, refresh);
    };
  }, []);
  return announcements;
}
