// Talks to the license server's admin API (gemini-web2api, ADMIN_TOKEN): every
// account has one kl_ license there, the key that unlocks the AI in the app.
// Its key is rotated on every sign-in, so only the latest computer keeps working.

const FREE_MONTHLY_TOKENS = Number(process.env.FREE_MONTHLY_TOKENS || 4_000_000);

function base(): string {
  const explicit = process.env.LICENSE_ADMIN_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  return (process.env.LICENSE_SERVER_URL || "https://gemini.kikito.site/v1").replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

async function admin<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = process.env.LICENSE_ADMIN_TOKEN;
  if (!token) throw new Error("LICENSE_ADMIN_TOKEN não configurado no site.");
  const response = await fetch(`${base()}/admin/api/licenses${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(`servidor de licenças: ${data?.error?.message || response.status}`);
  return data;
}

/** Monthly AI tokens for a plan: 0 is no limit (paid plans). */
export function tokensFor(pro: boolean) {
  return pro ? 0 : FREE_MONTHLY_TOKENS;
}

export async function createLicense(email: string, pro: boolean): Promise<{ id: string; key: string }> {
  const data = await admin<{ license: { id: string }; key: string }>("POST", "", {
    name: email,
    notes: "conta do site",
    monthly_tokens: tokensFor(pro) || 0,
    max_devices: 1,
  });
  // POST treats 0 as "use the default", so set the real limit right after.
  await admin("PATCH", `/${data.license.id}`, { monthly_tokens: tokensFor(pro) });
  return { id: data.license.id, key: data.key };
}

export async function rotateLicense(id: string): Promise<string> {
  const data = await admin<{ key: string }>("POST", `/${id}/rotate`);
  return data.key;
}

export async function syncLicense(id: string, fields: { pro: boolean; blocked: boolean }) {
  await admin("PATCH", `/${id}`, { monthly_tokens: tokensFor(fields.pro), status: fields.blocked ? "blocked" : "active" });
}

export async function resetLicenseDevices(id: string) {
  await admin("DELETE", `/${id}/devices`);
}
