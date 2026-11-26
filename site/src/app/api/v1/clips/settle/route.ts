import { accountFromRequest, finishCutJob, settleClips } from "@/lib/accounts";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * The video or live is done with `clips` cuts: the free plan's unused reserved cuts
 * come back (`source`), and the logged job (`job`, any plan) records what it made.
 */
export async function POST(request: Request) {
  try {
    const { sql, account, device } = await accountFromRequest(request);
    const body = (await request.json().catch(() => ({}))) as { source?: unknown; clips?: unknown; job?: unknown };
    const source = String(body.source ?? "").trim();
    if (source) await settleClips(sql, device, source, Number(body.clips));
    if (body.job) await finishCutJob(sql, account, body.job, Number(body.clips));
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
