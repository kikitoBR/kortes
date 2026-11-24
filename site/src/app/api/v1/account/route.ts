import { accountFromRequest, summary } from "@/lib/accounts";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** The signed-in account: plan and free cuts left. */
export async function GET(request: Request) {
  try {
    const { sql, account, device } = await accountFromRequest(request);
    return json(await summary(sql, account, device));
  } catch (error) {
    return errorResponse(error);
  }
}
