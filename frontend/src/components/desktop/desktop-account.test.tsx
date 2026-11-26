import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { AccountCard, DesktopVersion } from "./desktop-account";

function signIn(next: "password" | "first" | "new") {
  const calls: { path: string; body: unknown }[] = [];
  server.use(
    http.post("/api/desktop/account/check", async ({ request }) => {
      calls.push({ path: "check", body: await request.json() });
      return HttpResponse.json({ next });
    }),
    http.post("/api/desktop/account/:action", async ({ request, params }) => {
      calls.push({ path: String(params.action), body: await request.json() });
      return HttpResponse.json({ account: { signed_in: true, email: "c@ex.com" } });
    }),
  );
  return calls;
}

async function typeEmail() {
  const user = userEvent.setup();
  const onChange = vi.fn(async () => {});
  render(<AccountCard account={{ signed_in: false }} onChange={onChange} />);
  expect(screen.queryByPlaceholderText(/senha/i)).toBeNull();
  await user.type(screen.getByPlaceholderText("Seu e-mail"), "c@ex.com");
  await user.click(screen.getByRole("button", { name: "Continuar" }));
  return { user, onChange };
}

it("asks only the e-mail first, then the password of an account that has one", async () => {
  const calls = signIn("password");
  const { user, onChange } = await typeEmail();
  await user.type(await screen.findByPlaceholderText("Sua senha"), "segredo123");
  expect(screen.queryByPlaceholderText("Repita a senha")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Entrar" }));
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(calls.map((call) => call.path)).toEqual(["check", "login"]);
});

it("lets a buyer with no password create one", async () => {
  const calls = signIn("first");
  const { user, onChange } = await typeEmail();
  expect(await screen.findByText(/Encontramos sua compra/)).toBeVisible();
  await user.type(screen.getByPlaceholderText(/Crie uma senha/), "segredo123");
  await user.type(screen.getByPlaceholderText("Repita a senha"), "segredo123");
  await user.click(screen.getByRole("button", { name: "Criar senha e entrar" }));
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(calls.at(-1)).toEqual({ path: "set-password", body: { email: "c@ex.com", password: "segredo123", name: "" } });
});

it("offers a free account to a new e-mail and lets the e-mail be changed", async () => {
  signIn("new");
  const { user } = await typeEmail();
  expect(await screen.findByRole("button", { name: "Criar conta grátis" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Trocar e-mail" }));
  expect(screen.getByPlaceholderText("Seu e-mail")).toHaveValue("c@ex.com");
  expect(screen.getByRole("button", { name: "Continuar" })).toBeVisible();
});

it("shows the app version", async () => {
  server.use(http.get("/api/desktop/version", () => HttpResponse.json({ version: "1.0.8" })));
  render(<DesktopVersion />);
  expect(await screen.findByText("Kortes 1.0.8")).toBeVisible();
});
