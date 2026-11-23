import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Published announcements, newest first. Public: the Kortes app shows them as "Novidades". */
export async function GET() {
  try {
    const sql = await db();
    const rows = await sql`
      SELECT id, title, description, action, href, published_at
      FROM announcements
      WHERE is_published AND published_at <= now()
      ORDER BY published_at DESC
      LIMIT 20`;
    const announcements = rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      description: row.description as string,
      action: row.action as string,
      href: row.href as string,
      publishedAt: (row.published_at as Date).toISOString(),
    }));
    return json({ announcements }, 200, { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" });
  } catch (error) {
    return errorResponse(error);
  }
}
