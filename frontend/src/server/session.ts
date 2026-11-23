import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { isDesktop, LOCAL_USER } from "@/lib/edition";
import prisma from "@/lib/prisma";

let localUserReady: Promise<unknown> | null = null;

/** Kortes Desktop has one local user, created on first use. */
function ensureLocalUser() {
  localUserReady ??= prisma.user
    .upsert({
      where: { id: LOCAL_USER.id },
      update: {},
      create: {
        id: LOCAL_USER.id,
        name: LOCAL_USER.name,
        email: LOCAL_USER.email,
        emailVerified: true,
      },
    })
    .catch((error: unknown) => {
      localUserReady = null;
      throw error;
    });
  return localUserReady;
}

async function getDesktopSession() {
  await ensureLocalUser();
  const now = new Date();
  return {
    user: { ...LOCAL_USER, createdAt: now, updatedAt: now },
    session: {
      id: "local-session",
      userId: LOCAL_USER.id,
      token: "local",
      expiresAt: new Date(now.getTime() + 86_400_000),
      createdAt: now,
      updatedAt: now,
    },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>;
}

export async function getServerSession() {
  if (isDesktop) return getDesktopSession();
  return auth.api.getSession({ headers: await headers() });
}
