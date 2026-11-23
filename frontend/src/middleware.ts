import { NextResponse, type NextRequest } from "next/server";

import { isDesktop, isWebOnlyPath } from "@/lib/edition";

/** Kortes Desktop: web-only pages go home, web-only API routes do not exist. */
export function middleware(request: NextRequest) {
  if (!isDesktop) return NextResponse.next();
  const kind = isWebOnlyPath(request.nextUrl.pathname);
  if (kind === "api") {
    return NextResponse.json({ error: "Não disponível no Kortes Desktop" }, { status: 404 });
  }
  if (kind === "page") {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/|favicon|icon|logo|.*\.(?:png|svg|jpg|jpeg|webp|ico|txt|xml|js|css|woff2?)$).*)"],
};
