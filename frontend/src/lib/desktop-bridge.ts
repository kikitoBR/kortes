// Kortes Desktop's bridge to Windows (desktop/src/preload.js). Undefined on the web
// and in a plain browser.

type KortesDesktopBridge = {
  /** Folder picker; resolves to the chosen folder or null when cancelled. */
  pickFolder: (current?: string) => Promise<string | null>;
  /** Opens the folder in Explorer; resolves to "" or the reason it could not. */
  openFolder: (folder: string) => Promise<string>;
};

export function desktopBridge(): KortesDesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { kortesDesktop?: KortesDesktopBridge }).kortesDesktop;
}
