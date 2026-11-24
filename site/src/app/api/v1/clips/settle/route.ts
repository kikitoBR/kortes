import { accountFromRequest, settleClips } from "@/lib/accounts";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** The video or live is done with `clips` cuts: the unused reserved cuts come back. */
export async function POST(request: Request) {
  try {
    const { sql, device } = await accountFromRequest(request);
    const body = (await request.json().catch(() => ({}))) as { source?: unknown; clips?: unknown };
    const source = String(body.source ?? "").trim();
    if (source) await settleClips(sql, device, source, Number(body.clips));
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
