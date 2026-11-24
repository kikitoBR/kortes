import { accountFromRequest, settleClips } from "@/lib/accounts";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** The video gave no cut (error or cancelled): its reserved cuts come back. */
export async function POST(request: Request) {
  try {
    const { sql, device } = await accountFromRequest(request);
    const body = (await request.json().catch(() => ({}))) as { source?: unknown };
    const source = String(body.source ?? "").trim();
    if (source) await settleClips(sql, device, source, 0);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
