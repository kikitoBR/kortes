// Emails from the site (password resets). Two ways, whichever is configured:
// - SMTP, e.g. the domain's Hostinger mailbox: SMTP_HOST (smtp.hostinger.com),
//   SMTP_PORT (465), SMTP_USER (the full address) and SMTP_PASS (its password);
// - Resend: RESEND_API_KEY, with MAIL_FROM on a domain verified there.
// Without either, the link goes to the server log and the panel can make one by hand.

import nodemailer from "nodemailer";

const SITE = (process.env.SITE_URL || "https://kortes.com.br").replace(/\/$/, "");

export function resetUrl(token: string) {
  return `${SITE}/redefinir-senha?token=${encodeURIComponent(token)}`;
}

type Mail = { to: string; subject: string; html: string; text: string };

function sender() {
  return process.env.MAIL_FROM || (process.env.SMTP_USER ? `Kortes <${process.env.SMTP_USER}>` : "Kortes <nao-responda@kortes.com.br>");
}

async function sendSmtp(mail: Mail) {
  const port = Number(process.env.SMTP_PORT || 465);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 15_000,
  });
  await transport.sendMail({ from: sender(), ...mail });
}

async function sendResend(mail: Mail) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: sender(), to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!response.ok) throw new Error(`Resend ${response.status}: ${await response.text().catch(() => "")}`);
}

/** Whether the site can send email at all (the panel says so). */
export const mailConfigured = () => Boolean(process.env.SMTP_HOST || process.env.RESEND_API_KEY);

export async function sendPasswordReset(email: string, token: string) {
  const link = resetUrl(token);
  if (!mailConfigured()) {
    console.warn(`[kortes] e-mail não configurado (SMTP_HOST ou RESEND_API_KEY): link de redefinição para ${email}: ${link}`);
    return;
  }
  const mail: Mail = {
    to: email,
    subject: "Kortes: criar uma nova senha",
    text: `Crie uma nova senha para o Kortes (vale por 1 hora): ${link}`,
    html: `
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#0c0a09">
      <h1 style="font-size:22px">Criar uma nova senha</h1>
      <p>Recebemos um pedido para trocar a senha da sua conta do Kortes.</p>
      <p><a href="${link}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#eb5116;color:#fff;font-weight:700;text-decoration:none">Criar nova senha</a></p>
      <p style="color:#78716c;font-size:14px">O link vale por 1 hora. Se não foi você, ignore este e-mail.</p>
    </div>`,
  };
  try {
    await (process.env.SMTP_HOST ? sendSmtp(mail) : sendResend(mail));
  } catch (error) {
    console.error("[kortes] e-mail de redefinição falhou", error instanceof Error ? error.message : error);
  }
}
