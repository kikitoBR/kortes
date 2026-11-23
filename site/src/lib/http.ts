import { NextResponse } from "next/server";
import { LicenseError } from "./license";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(data, { status, headers });
}

export function errorResponse(error: unknown) {
  if (error instanceof LicenseError) return json({ detail: error.message }, error.status);
  console.error(error);
  return json({ detail: "Erro no servidor do Kortes. Tente de novo em instantes." }, 500);
}
