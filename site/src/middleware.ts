import { NextResponse, type NextRequest } from "next/server";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";

/** /painel needs the admin login; everything else is public. */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/painel/entrar") return NextResponse.next();
  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/painel/entrar";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/painel", "/painel/:path*"] };
