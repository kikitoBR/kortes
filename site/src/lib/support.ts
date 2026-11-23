export const CATEGORIES = {
  support: "Suporte / problema",
  bug: "Erro no app",
  feature: "Sugestão",
  general: "Feedback",
} as const;

export type Category = keyof typeof CATEGORIES;

export const STATUS_LABELS: Record<string, string> = {
  open: "Aguardando você",
  answered: "Respondida",
  closed: "Encerrada",
};

export const MESSAGE_MAX = 4000;

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && value in CATEGORIES;
}

export function subjectFrom(body: string): string {
  const line = body.trim().split(/\r?\n/)[0];
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** A link in an announcement: a page of the app (/settings) or an https address. */
export function isValidHref(href: string): boolean {
  if (!href) return true;
  if (/^\/(?!\/)[^\s\\]*$/.test(href)) return true;
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
}
