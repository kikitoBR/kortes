"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSessionValue, isValidSession, passwordMatches, SESSION_COOKIE, SESSION_DAYS } from "@/lib/auth";
import { db } from "@/lib/db";
import { isValidHref, MESSAGE_MAX } from "@/lib/support";

async function requireAdmin() {
  const store = await cookies();
  if (!(await isValidSession(store.get(SESSION_COOKIE)?.value))) redirect("/painel/entrar");
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export async function login(form: FormData) {
  if (!(await passwordMatches(text(form, "password")))) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    redirect("/painel/entrar?erro=1");
  }
  const store = await cookies();
  store.set(SESSION_COOKIE, await createSessionValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/painel",
    maxAge: SESSION_DAYS * 24 * 3600,
  });
  redirect("/painel");
}

export async function logout() {
  const store = await cookies();
  store.delete({ name: SESSION_COOKIE, path: "/painel" });
  redirect("/painel/entrar");
}

export async function reply(form: FormData) {
  await requireAdmin();
  const id = text(form, "thread");
  const body = text(form, "message").replace(/\r\n/g, "\n");
  const close = form.get("close") === "1";
  if (!isId(id)) return;
  const sql = await db();
  if (body) {
    await sql`INSERT INTO support_messages (thread_id, author, body) VALUES (${id}, 'admin', ${body.slice(0, MESSAGE_MAX)})`;
  }
  await sql`
    UPDATE support_threads SET status = ${close ? "closed" : body ? "answered" : "open"}, updated_at = now()
    WHERE id = ${id}`;
  revalidatePath(`/painel/mensagens/${id}`);
  revalidatePath("/painel");
}

export async function setThreadStatus(form: FormData) {
  await requireAdmin();
  const id = text(form, "thread");
  const status = text(form, "status");
  if (!isId(id) || !["open", "answered", "closed"].includes(status)) return;
  const sql = await db();
  await sql`UPDATE support_threads SET status = ${status} WHERE id = ${id}`;
  revalidatePath(`/painel/mensagens/${id}`);
  revalidatePath("/painel");
}

export async function deleteThread(form: FormData) {
  await requireAdmin();
  const id = text(form, "thread");
  if (!isId(id)) return;
  const sql = await db();
  await sql`DELETE FROM support_threads WHERE id = ${id}`;
  revalidatePath("/painel");
  redirect("/painel");
}

function announcementFrom(form: FormData) {
  const title = text(form, "title").slice(0, 120);
  const description = text(form, "description").slice(0, 2000);
  const action = text(form, "action").slice(0, 80);
  const href = text(form, "href").slice(0, 500);
  const published = form.get("published") === "on";
  const when = text(form, "published_at");
  const publishedAt = when ? new Date(`${when}:00-03:00`) : new Date();
  if (!title || !description) return { error: "Preencha título e texto." } as const;
  if (!isValidHref(href)) return { error: "O link precisa começar com https:// ou ser uma página do app, como /settings." } as const;
  if (href && !action) return { error: "Escreva o texto do botão do link." } as const;
  if (Number.isNaN(publishedAt.getTime())) return { error: "Data de publicação inválida." } as const;
  return { data: { title, description, action, href, published, publishedAt } } as const;
}

export async function saveAnnouncement(form: FormData) {
  await requireAdmin();
  const id = text(form, "id");
  const parsed = announcementFrom(form);
  if ("error" in parsed) redirect(`/painel/avisos?erro=${encodeURIComponent(parsed.error ?? "")}`);
  const a = parsed.data!;
  const sql = await db();
  if (id && isId(id)) {
    await sql`
      UPDATE announcements SET title = ${a.title}, description = ${a.description}, action = ${a.action},
        href = ${a.href}, is_published = ${a.published}, published_at = ${a.publishedAt}, updated_at = now()
      WHERE id = ${id}`;
  } else {
    await sql`
      INSERT INTO announcements (title, description, action, href, is_published, published_at)
      VALUES (${a.title}, ${a.description}, ${a.action}, ${a.href}, ${a.published}, ${a.publishedAt})`;
  }
  revalidatePath("/painel/avisos");
  redirect("/painel/avisos?ok=1");
}

export async function deleteAnnouncement(form: FormData) {
  await requireAdmin();
  const id = text(form, "id");
  if (!isId(id)) return;
  const sql = await db();
  await sql`DELETE FROM announcements WHERE id = ${id}`;
  revalidatePath("/painel/avisos");
}
