"use client";

import { useEffect, useRef, useState } from "react";
import { notifyClipReady } from "@/lib/desktop-notify";

type ProgressEvent = { progress?: number; message?: string; status?: string };

/** SSE is the fast path; reconciliation also recovers missed terminal events. */
export function useTaskProgress<T>({ taskId, active, refresh, onProgress, onClip, onShow }: {
  taskId: string;
  active: boolean;
  refresh: () => Promise<unknown>;
  onProgress: (event: ProgressEvent) => void;
  onClip: (clip: T) => void;
  /** The assembly show's state changed (the clip being made, the queue). */
  onShow?: (show: Record<string, unknown>) => void;
}) {
  const callbacks = useRef({ refresh, onProgress, onClip, onShow });
  callbacks.current = { refresh, onProgress, onClip, onShow };
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (!active || !taskId) {
      setReconnecting(false);
      return;
    }
    let disposed = false;
    let refreshing = false;
    const reconcile = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      try { await callbacks.current.refresh(); }
      catch { /* Keep retrying; a transport failure is not a failed generation. */ }
      finally { refreshing = false; }
    };
    const source = new EventSource(`/api/tasks/${taskId}/progress`);
    source.onopen = () => setReconnecting(false);
    source.onerror = () => {
      setReconnecting(true);
      void reconcile();
      // Leave the source open so the browser reconnects with its retry policy.
    };
    const read = (event: Event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data);
        return data && typeof data === "object" ? data : null;
      } catch { void reconcile(); return null; }
    };
    const progress = (event: Event) => {
      const data = read(event);
      if (!data) return;
      callbacks.current.onProgress(data);
      if (["completed", "cancelled", "error"].includes(data.status)) void reconcile();
    };
    source.addEventListener("status", progress);
    source.addEventListener("progress", progress);
    source.addEventListener("clip_ready", (event) => {
      const data = read(event);
      if (data?.clip) {
        callbacks.current.onClip(data.clip as T);
        void notifyClipReady(data.clip as { hook_title?: string | null });
      }
    });
    source.addEventListener("show", (event) => {
      const data = read(event);
      if (data?.show && typeof data.show === "object") callbacks.current.onShow?.(data.show);
    });
    source.addEventListener("close", () => {
      source.close();
      void reconcile();
    });
    const timer = window.setInterval(() => { void reconcile(); }, 5000);
    const onVisible = () => { if (document.visibilityState === "visible") void reconcile(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      disposed = true;
      source.close();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [taskId, active]);
  return { reconnecting };
}
