import { NextResponse } from "next/server";

import { isDesktop } from "@/lib/edition";
import { createProxyResponse, fetchBackend } from "@/server/backend-api";
import { getServerSession } from "@/server/session";

/** Kortes Desktop setup (license, AssemblyAI key), proxied to the backend's /desktop routes. */
async function proxyDesktopRequest(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!isDesktop) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const session = await getServerSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  const body = request.method === "GET" ? undefined : await request.text();
  const upstream = await fetchBackend(`/desktop/${path.join("/")}`, {
    method: request.method,
    userId: session.user.id,
    extraHeaders: body ? { "Content-Type": "application/json" } : {},
    body: body || undefined,
    cache: "no-store",
  });
  return createProxyResponse(upstream);
}

export const GET = proxyDesktopRequest;
export const POST = proxyDesktopRequest;
export const DELETE = proxyDesktopRequest;
