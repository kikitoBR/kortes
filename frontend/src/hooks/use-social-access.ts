"use client";

import { useEffect, useState } from "react";

import { isDesktop } from "@/lib/edition";

// One request per page load, shared by the shell and the pages it wraps.
let pending: Promise<boolean> | null = null;

function loadSocialAccess() {
  // Kortes Desktop has no social publishing.
  if (isDesktop) return Promise.resolve(false);
  pending ??= fetch("/api/social/providers", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return false;
      const data = (await response.json()) as { enabled?: boolean };
      // Servers that predate the rollout flag don't send it.
      return data.enabled !== false;
    })
    .catch(() => false);
  return pending;
}

/** Whether social publishing is available to the signed-in user (null while loading). */
export function useSocialAccess(enabled = true) {
  const [access, setAccess] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadSocialAccess().then((value) => {
      if (!cancelled) setAccess(value);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return access;
}
