# kortes.com.br

O site do Kortes (Next.js, na Vercel). Por enquanto:

- `/`: página "em breve" (a landing vem depois)
- `/painel`: gerenciamento, protegido por senha (fora do Google: `noindex` e `robots.txt`)
  - **Mensagens:** suporte e feedback enviados pelo Kortes Desktop. Sua resposta aparece no app do cliente.
  - **Avisos:** as "Novidades" que aparecem no app de todos os clientes (link externo ou página do app).
- `/api/v1/*`: o que o app chama
  - `GET /api/v1/announcements`: avisos publicados (público)
  - `GET|POST /api/v1/support` e `POST /api/v1/support/{id}/messages`: conversas do cliente.
    O app manda a licença (`Authorization: Bearer kl_...`), o id do PC (`x-kortes-device`) e a versão
    (`x-kortes-version`). O site confere a licença no servidor de licenças (`GET /v1/license` do
    gemini-web2api) e guarda só o SHA-256 dela.

As tabelas são criadas sozinhas na primeira chamada (não há migração para rodar).

## Subir na Vercel

1. **Add New → Project**, importe `kikitoBR/kortes` e em **Root Directory** escolha `site`.
   O resto a Vercel detecta (Next.js, pnpm).
2. **Storage → Create Database → Neon (Postgres)** e conecte ao projeto. Isso cria `DATABASE_URL`.
3. **Settings → Environment Variables:**
   - `ADMIN_PASSWORD`: a senha do painel (longa; trocar desconecta quem estiver logado)
   - `DISCORD_WEBHOOK_URL` (opcional): avisa num canal quando chega mensagem
   - `LICENSE_SERVER_URL` (opcional): padrão `https://gemini.kikito.site/v1`
4. **Deploy**, depois **Settings → Domains → kortes.com.br** e aponte o DNS como a Vercel mostrar.
5. Abra `https://kortes.com.br/painel`.

Enquanto kortes.com.br não aponta para a Vercel, o app não alcança o site: o botão de suporte mostra
"Não deu para falar com o servidor do Kortes" e as Novidades ficam vazias. Para testar antes, rode o
app com `KORTES_SITE_URL=https://<projeto>.vercel.app`.

## Rodar local

```bash
pnpm install
DATABASE_URL=postgres://usuario@127.0.0.1:5432/kortes ADMIN_PASSWORD=teste pnpm dev
```

Porta 3300.
