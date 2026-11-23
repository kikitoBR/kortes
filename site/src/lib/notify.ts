// Optional: a message in a Discord channel when a customer writes (DISCORD_WEBHOOK_URL).
export async function notifyNewMessage(options: { customer: string; category: string; body: string; threadId: string; isNew: boolean }) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  const site = process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: options.isNew ? `Nova mensagem: ${options.category}` : "Cliente respondeu",
            description: options.body.slice(0, 1800),
            url: site ? `${site}/painel/mensagens/${options.threadId}` : undefined,
            fields: [{ name: "Cliente", value: options.customer || "sem nome", inline: true }],
            color: 0xf06a2c,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // The message is saved either way.
  }
}
