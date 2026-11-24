import { AccountError, checkPassword, normalizeEmail, validEmail } from "@/lib/accounts";

/** email + password from the app's JSON body, checked. */
export async function credentials(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown; name?: unknown };
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? "");
  if (!validEmail(email)) throw new AccountError("Digite um e-mail válido.");
  if (!password) throw new AccountError("Digite a sua senha.");
  return { email, password, name: String(body.name ?? "").trim().slice(0, 120) };
}

export { checkPassword };
