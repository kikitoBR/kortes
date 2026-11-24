import type { Metadata } from "next";

import { Backstage } from "./backstage";
import { DownloadButton } from "./download-button";
import { geist, syne } from "./fonts";
import { HeroCut } from "./hero-cut";
import { Pricing } from "./pricing";
import { latestRelease } from "./release";
import "./landing.css";


const TITLE = "Kortes · Corte a live enquanto ela acontece";
const DESCRIPTION =
  "Cole o link da live da Twitch, Kick ou YouTube. A IA do Kortes acha os momentos virais e entrega o corte vertical com legenda e título em minutos. IA inclusa, sem créditos.";

// The share image comes from opengraph-image.jpg / twitter-image.jpg next to this file.
export const metadata: Metadata = {
  metadataBase: new URL("https://kortes.com.br"),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", url: "/", siteName: "Kortes", locale: "pt_BR", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

function Scissors({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden>
      <g stroke="#9D9FA2" strokeWidth="16.6" fill="none">
        <circle cx="44.3" cy="61.1" r="25" />
        <line x1="44.3" y1="86.1" x2="103.5" y2="86.1" />
        <line x1="150" y1="86.1" x2="180.7" y2="86.1" strokeLinecap="round" />
      </g>
      <g stroke="currentColor" strokeWidth="16.6" fill="none">
        <circle cx="77.7" cy="147.3" r="25" />
        <line x1="60.02" y1="129.62" x2="156.34" y2="33.3" strokeLinecap="round" />
      </g>
    </svg>
  );
}

// Small line icons (24px, stroke = currentColor).
const ICONS: Record<string, React.ReactNode> = {
  link: <path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.2 1.2M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.2-1.2" />,
  wave: <path d="M3 12h2m3-5v10m4-14v18m4-12v6m4-3h1" />,
  check: <path d="M20 6 9 17l-5-5" />,
  frame: <><rect x="7" y="2" width="10" height="20" rx="2.5" /><path d="M7 9h10" /></>,
  text: <path d="M4 7V5h16v2M9 19h6M12 5v14" />,
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />,
  live: <><circle cx="12" cy="12" r="2.5" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4m8.4 0a6 6 0 0 0 0-8.4M4.9 4.9a10 10 0 0 0 0 14.2m14.2 0a10 10 0 0 0 0-14.2" /></>,
  pc: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
};
function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <span className="lp-icon" aria-hidden>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{ICONS[name]}</svg>
    </span>
  );
}

const STEPS = [
  { n: "01", icon: "link", t: "Cole o link", d: "A live da Twitch, da Kick ou do YouTube, ou um vídeo de até 10 horas." },
  { n: "02", icon: "wave", t: "A IA assiste com você", d: "Grava, transcreve e mede os picos de voz enquanto a live está no ar." },
  { n: "03", icon: "check", t: "O corte chega pronto", d: "Vertical, com legenda, título e webcam enquadrada. É só postar." },
] as const;

const FAQ = [
  { q: "Como funciona o plano grátis?", a: "Você cria a conta no próprio Kortes e ganha 15 cortes, até 5 por vídeo ou live, de qualquer duração, com a marca d'água do Kortes. No vídeo vêm os 5 melhores momentos; se ele render menos, o que sobrar fica para o próximo. Para cortar sem limite, assine o Pro." },
  { q: "Comprei. Como entro no Kortes?", a: "Abra o Kortes e entre com o mesmo e-mail da compra. No primeiro acesso você cria a sua senha." },
  { q: "Posso usar em mais de um computador?", a: "Cada conta funciona em um computador. Se trocar de PC, fale com o suporte pelo botão de mensagens do app." },
  { q: "Preciso pagar uma assinatura de IA à parte?", a: "Não. A IA que escolhe e revisa os cortes já vem na licença do Kortes: sem créditos e sem cobrança extra." },
  { q: "Em quais plataformas funciona?", a: "Lives da Twitch, da Kick e do YouTube enquanto estão no ar, e vídeos do YouTube ou arquivos seus de até 10 horas." },
  { q: "Roda em qual sistema?", a: "Windows 10 e 11 (64 bits). O Kortes é um programa: os vídeos são processados no seu computador." },
  { q: "E a transcrição das legendas?", a: "Usa a sua chave da AssemblyAI, se você tiver uma, ou o Whisper direto no seu PC, sem custo." },
  { q: "Como recebo as novidades?", a: "O Kortes se atualiza sozinho. Os avisos da equipe aparecem em Novidades, dentro do app." },
  { q: "E se eu precisar de ajuda?", a: "O botão de mensagens dentro do Kortes fala direto com a equipe. A resposta chega ali mesmo." },
];

export default async function Home() {
  const release = await latestRelease();
  const meta = ["Windows 10 e 11 · 64 bits", release.version && `versão ${release.version}`, release.sizeMb && `${release.sizeMb} MB`]
    .filter(Boolean)
    .join(" · ");
  // What Google reads: the app and the FAQ.
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Kortes",
      operatingSystem: "Windows 10, Windows 11",
      applicationCategory: "MultimediaApplication",
      description: DESCRIPTION,
      url: "https://kortes.com.br",
      ...(release.version ? { softwareVersion: release.version } : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ];
  return (
    <main id="conteudo" className={`lp ${syne.variable} ${geist.variable}`}>
      <a className="lp-skip" href="#ao-vivo">Pular para o conteúdo</a>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="lp-bg" aria-hidden>
        <i /><i /><i />
      </div>

      <header className="lp-nav">
        <a href="#" className="lp-logo"><Scissors /> Kortes</a>
        <nav>
          <a href="#ao-vivo">Ao vivo</a>
          <a href="#como-funciona">Como funciona</a>
          <a href="#recursos">Recursos</a>
          <a href="#planos">Planos</a>
          <a href="#perguntas">Perguntas</a>
        </nav>
        <a className="lp-btn lp-btn-sm" href="#baixar">Baixar</a>
      </header>

      <HeroCut />

      <section id="ao-vivo" className="lp-section">
        <p className="lp-eyebrow">O diferencial</p>
        <h2 className="lp-h2">Enquanto os outros esperam a live acabar, <span>você já postou.</span></h2>
        <div className="lp-race lp-glass">
          <div className="lp-race-row">
            <b>Kortes</b>
            <div className="lp-race-bar"><i className="lp-race-k" /></div>
            <span className="lp-race-v">≈ 3 min</span>
          </div>
          <div className="lp-race-row is-muted">
            <b>Do jeito antigo</b>
            <div className="lp-race-bar"><i className="lp-race-o" /></div>
            <span className="lp-race-v">fim da live + download + edição</span>
          </div>
          <p className="lp-small">O Kortes corta durante a live: cada momento forte vira corte poucos minutos depois de acontecer. Quem espera a live terminar posta quando o assunto já esfriou.</p>
        </div>
      </section>

      <section id="como-funciona" className="lp-section">
        <p className="lp-eyebrow">Como funciona</p>
        <h2 className="lp-h2">Três passos. <span>Um deles é seu.</span></h2>
        <ol className="lp-steps">
          {STEPS.map((s) => (
            <li key={s.n} className="lp-glass lp-reveal">
              <div className="lp-step-top"><span className="lp-step-n">{s.n}</span><Icon name={s.icon} /></div>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="recursos" className="lp-section">
        <p className="lp-eyebrow">Recursos</p>
        <h2 className="lp-h2">Tudo que um editor faria. <span>Sem esperar.</span></h2>
        <div className="lp-bento">
          <article className="lp-glass lp-tile lp-tile-wide lp-reveal">
            <Icon name="frame" /><h3>Enquadramento automático</h3>
            <p>Acha a webcam do streamer e monta o 9:16: rosto em cima, jogo embaixo, centralizado.</p>
            <div className="lp-frame-demo" aria-hidden>
              <div className="lp-fd-src"><i className="lp-fd-cam" /><i className="lp-fd-game" /></div>
              <span className="lp-fd-arrow">→</span>
              <div className="lp-fd-phone"><i /><i /></div>
            </div>
          </article>
          <article className="lp-glass lp-tile lp-reveal">
            <Icon name="text" /><h3>Legenda palavra a palavra</h3>
            <p className="lp-caption-demo"><span>O QUE É</span> <b>ISSO?</b></p>
          </article>
          <article className="lp-glass lp-tile lp-reveal">
            <Icon name="spark" /><h3>Título que prende</h3>
            <p>A IA escreve o gancho do topo nos primeiros segundos de cada corte.</p>
          </article>
          <article className="lp-glass lp-tile lp-reveal">
            <Icon name="spark" /><h3>Ajustar escrevendo</h3>
            <p className="lp-type-demo">começa 3 s antes</p>
            <p>A IA refaz o corte do jeito que você pediu.</p>
          </article>
          <article className="lp-glass lp-tile lp-reveal">
            <Icon name="live" /><h3>Twitch, Kick e YouTube</h3>
            <p>Lives no ar e vídeos de até 10 horas.</p>
          </article>
          <article className="lp-glass lp-tile lp-reveal">
            <Icon name="pc" /><h3>No seu computador</h3>
            <p>Um programa para Windows que se atualiza sozinho.</p>
          </article>
        </div>
      </section>

      <section id="ia" className="lp-section lp-ai">
        <p className="lp-eyebrow">IA inclusa</p>
        <h2 className="lp-h2">Sem outra assinatura de IA. <span>Ela já vem no Kortes.</span></h2>
        <ul className="lp-pills">
          <li className="lp-glass">✓ Sem créditos</li>
          <li className="lp-glass">✓ Sem cobrança extra</li>
          <li className="lp-glass">∞ Uso ilimitado</li>
        </ul>
      </section>

      <section id="bastidores" className="lp-section">
        <p className="lp-eyebrow">Bastidores</p>
        <h2 className="lp-h2">Veja o agente <span>montando o corte.</span></h2>
        <p className="lp-lead">A Câmera enquadra, o Diretor escolhe o trecho, o Montador escreve o título e a Legendista sincroniza cada palavra. Tudo enquanto a live segue.</p>
        <Backstage />
      </section>

      <section id="planos" className="lp-section">
        <p className="lp-eyebrow">Planos</p>
        <h2 className="lp-h2">Comece grátis. <span>Corte sem limite no Pro.</span></h2>
        <Pricing />
      </section>

      <section id="perguntas" className="lp-section">
        <p className="lp-eyebrow">Perguntas</p>
        <h2 className="lp-h2">Antes de baixar</h2>
        <div className="lp-faq">
          {FAQ.map((f) => (
            <details key={f.q} className="lp-glass">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section id="baixar" className="lp-section lp-final">
        <Scissors size={72} />
        <h2 className="lp-h2">Corte a live <span>enquanto ela acontece.</span></h2>
        <DownloadButton href={release.url} meta={`${meta} · a licença é ativada no primeiro uso`} />
      </section>

      <footer className="lp-footer">
        <div>
          <a href="#" className="lp-logo lp-logo-sm"><Scissors size={22} /> Kortes</a>
          <p>Cortes virais da sua live, enquanto ela acontece.</p>
        </div>
        <nav aria-label="Rodapé">
          <a href="#ao-vivo">Ao vivo</a>
          <a href="#como-funciona">Como funciona</a>
          <a href="#recursos">Recursos</a>
          <a href="#planos">Planos</a>
          <a href="#perguntas">Perguntas</a>
          <a href="#baixar">Baixar</a>
        </nav>
        <p className="lp-footer-copy">© {new Date().getFullYear()} Kortes · Feito no Brasil</p>
      </footer>
    </main>
  );
}
