/**
 * Kortes Desktop (`NEXT_PUBLIC_KORTES_EDITION=desktop`): one person on their own
 * computer. No sign-in (a fixed local user), no billing, social publishing,
 * API keys, admin or marketing pages; a setup page for the license and the
 * AssemblyAI key instead. See `middleware.ts` for the routes it turns off.
 */
export const isDesktop = process.env.NEXT_PUBLIC_KORTES_EDITION === "desktop";

export const LOCAL_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Você",
  email: "voce@kortes.local",
  emailVerified: true,
  image: null,
  is_admin: false,
} as const;

/** Pages (and their API routes) that only exist on the web. */
export const WEB_ONLY_PAGES = [
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/admin",
  "/affiliate",
  "/analytics",
  "/settings/api-keys",
  "/settings/creator-program",
  "/settings/social",
  "/blog",
  "/demo",
  "/share",
  "/status",
] as const;

export const WEB_ONLY_API = [
  "/api/admin",
  "/api/affiliates",
  "/api/announcements",
  "/api/api-keys",
  "/api/attribution",
  "/api/feedback",
  "/api/service-status",
  "/api/share",
  "/api/social",
  "/api/billing/checkout",
  "/api/billing/portal",
  "/api/billing/resume",
  "/api/billing/webhook",
  "/api/billing/revenuecat-webhook",
] as const;

export function isWebOnlyPath(pathname: string): "page" | "api" | null {
  const matches = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  if (WEB_ONLY_API.some(matches)) return "api";
  if (WEB_ONLY_PAGES.some(matches)) return "page";
  return null;
}
