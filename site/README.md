# kortes.com.br

O site do Kortes (Next.js, na Vercel). Por enquanto:

- `/`: a landing. O hero (`src/app/hero-cut.tsx`) corta uma live 16:9 com a tesoura conforme a rolagem e
  monta o corte vertical num celular, tudo num canvas a partir de `public/hero/live.mp4` (`live-540.mp4` no
  celular); os recortes de webcam/jogo são os do detector do Kortes. "Bastidores" (`src/app/backstage.tsx`)
  mostra os agentes montando o corte. Estilos em `src/app/landing.css` (tudo sob `.lp`).
- `/planos`: Grátis, Pro mensal (R$ 49,90), Pro anual (R$ 397) e Vitalício (R$ 697), com os botões do checkout
  da Kirvano (`src/app/pricing.tsx`; também na landing, em `#planos`).
- `/esqueci-senha` e `/redefinir-senha`: o link de nova senha (por SMTP ou Resend), válido por 1 hora.
- `/painel`: gerenciamento, protegido por senha (fora do Google: `noindex` e `robots.txt`)
  - **Mensagens:** suporte e feedback enviados pelo Kortes Desktop. Sua resposta aparece no app do cliente.
  - **Avisos:** as "Novidades" que aparecem no app de todos os clientes (link externo ou página do app).
  - **Clientes:** as contas. Mudar plano, liberar a troca de PC, dar ou zerar cortes grátis do PC, bloquear,
    gerar link de nova senha, anotações e criar conta à mão.
  - **Pagamentos:** cada chamada da Kirvano como chegou e o que o site fez com ela.
- `/api/kirvano`: o webhook da Kirvano (veja abaixo).
- `/api/v1/*`: o que o app chama
  - `GET /api/v1/announcements`: avisos publicados (público)
  - `GET|POST /api/v1/support` e `POST /api/v1/support/{id}/messages`: conversas do cliente.
    O app manda a licença (`Authorization: Bearer kl_...`), o id do PC (`x-kortes-device`) e a versão
    (`x-kortes-version`). O site confere a licença no servidor de licenças (`GET /v1/license` do
    gemini-web2api) e guarda só o SHA-256 dela.

As tabelas são criadas sozinhas na primeira chamada (não há migração para rodar).

## Contas e planos

- **Login no app:** e-mail e senha (`/api/v1/auth/login|signup|set-password|logout`, `GET /api/v1/account`).
  Quem compra na Kirvano já tem conta sem senha: no primeiro login o app pede para criar a senha.
  Sem confirmação por e-mail.
- **1 computador por conta:** o primeiro login prende a conta ao PC (`x-kortes-device`, o MachineGuid do
  Windows com hash). Outro PC é recusado até você clicar em "Liberar troca de PC" no painel.
- **A chave da IA vem da conta:** cada conta tem uma licença `kl_` no servidor de licenças, criada e trocada
  a cada login pelo admin do gemini-web2api (`LICENSE_ADMIN_TOKEN`); a chave anterior para de funcionar.
  Plano grátis: `FREE_MONTHLY_TOKENS` por mês; planos pagos: sem limite.
- **Plano grátis:** um saldo de `FREE_CLIPS` (15) cortes **por computador**, até `FREE_CLIPS_PER_VIDEO` (5)
  por vídeo ou live, com marca d'água. O app reserva ao criar o vídeo (`/api/v1/clips/claim` responde quantos
  cortes fazer: 5, ou o que sobrou) e, no fim, conta os que saíram (`/api/v1/clips/settle`): um vídeo que
  rendeu 3 devolve 2 ao saldo; um que não rendeu nenhum devolve tudo e pode ser tentado de novo
  (só no dia da reserva). No vídeo saem os cortes de maior nota; na live, os primeiros momentos, na hora em
  que acontecem (a gravação para quando acabam). O mesmo vídeo não é cortado duas vezes. Criar outra conta no
  mesmo PC não dá cortes novos. "Dar cortes extras" no painel libera mais.
- **Chaves antigas:** quem digitou uma `kl_` antes das contas continua cortando sem limite. A chave de uma
  conta não vale fora dela (o site guarda o hash da chave atual de cada conta).

## Kirvano

Produto do tipo **Serviço** ("Kortes Pro") com três ofertas: Mensal e Anual (assinatura) e Vitalício
(preço único). Imagens do checkout em `public/checkout/` (logo, logo branca, ícone, banner 1500×400).

- **Webhook:** Integrações → Webhooks → Criar. URL `https://kortes.com.br/api/kirvano`, o token igual a
  `KIRVANO_WEBHOOK_TOKEN` (chega no cabeçalho `Security-Token`), o produto Kortes Pro e os eventos Compra
  aprovada, Assinatura renovada, Assinatura cancelada, Assinatura vencida, Plano da assinatura alterado,
  Reembolso, Chargeback e Devolução.
- **O que o site faz** (`src/app/api/kirvano/route.ts`, formato de help.kirvano.com): compra aprovada ou
  renovação → cria a conta pelo e-mail do comprador (se não existir) e dá o Pro até `plan.next_charge_date`
  (vitalício na compra de preço único); troca de plano → o novo plano; reembolso, chargeback ou devolução →
  volta ao grátis (a não ser que seja de outro plano: reembolsar um mensal antigo não tira um vitalício);
  assinatura vencida → o Pro acaba em 3 dias; cancelada → vale até a data já paga. O plano nunca desce.
  A Kirvano não reenvia sozinha, mas o reenvio manual repete o JSON: `sale_id` + evento + número da cobrança já
  aplicado é ignorado. A chave da IA é atualizada depois da resposta (a Kirvano espera no máximo 5 s).
  `KIRVANO_PLANS` (`{"<offer_id>":"monthly|yearly|lifetime"}`) só é preciso se as ofertas fugirem disso.
- **Página de obrigado:** `https://kortes.com.br/obrigado` (baixar o Kortes, entrar com o e-mail da compra,
  criar a senha no primeiro acesso).
- Toda chamada fica em **Painel → Pagamentos**, com o JSON e o que o site fez.

## Subir na Vercel

1. **Add New → Project**, importe `kikitoBR/kortes` e em **Root Directory** escolha `site`.
   O resto a Vercel detecta (Next.js, pnpm).
2. **Storage → Create Database → Neon (Postgres)** e conecte ao projeto. Isso cria `DATABASE_URL`.
3. **Settings → Environment Variables:**
   - `ADMIN_PASSWORD`: a senha do painel (longa; trocar desconecta quem estiver logado)
   - `DISCORD_WEBHOOK_URL` (opcional): avisa num canal quando chega mensagem
   - `LICENSE_SERVER_URL` (opcional): padrão `https://gemini.kikito.site/v1`
   - Contas e Kirvano: `LICENSE_ADMIN_TOKEN`, `KIRVANO_WEBHOOK_TOKEN`, `KIRVANO_CHECKOUT_MONTHLY|YEARLY|LIFETIME`.
   - E-mail de nova senha: `SMTP_HOST` (`smtp.hostinger.com`), `SMTP_PORT` (465), `SMTP_USER` (o endereço
     completo da caixa da Hostinger) e `SMTP_PASS`; ou `RESEND_API_KEY` + `MAIL_FROM`. Lista completa em
     `.env.example`.
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
