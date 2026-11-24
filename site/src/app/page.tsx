import type { Metadata } from "next";
import { Geist, Syne } from "next/font/google";

import { Backstage } from "./backstage";
import { HeroCut } from "./hero-cut";
import "./landing.css";

const syne = Syne({ subsets: ["latin", "latin-ext"], weight: ["600", "700", "800"], variable: "--font-syne" });
const geist = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-geist" });

const DOWNLOAD_URL = "https://github.com/kikitoBR/kortes/releases/latest";

export const metadata: Metadata = {
  title: "Kortes · Corte a live enquanto ela acontece",
  description:
    "Cole o link da live da Twitch, Kick ou YouTube. A IA do Kortes acha os momentos virais e entrega o corte vertical com legenda e título em minutos. IA inclusa, sem créditos.",
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

const STEPS = [
  { n: "01", t: "Cole o link", d: "A live da Twitch, da Kick ou do YouTube, ou um vídeo de até 10 horas." },
  { n: "02", t: "A IA assiste com você", d: "Grava, transcreve e mede os picos de voz enquanto a live está no ar." },
  { n: "03", t: "O corte chega pronto", d: "Vertical, com legenda, título e webcam enquadrada. É só postar." },
];

const FAQ = [
  { q: "Preciso pagar uma assinatura de IA à parte?", a: "Não. A IA que escolhe e revisa os cortes já vem na licença do Kortes: sem créditos e sem cobrança extra." },
  { q: "Em quais plataformas funciona?", a: "Lives da Twitch, da Kick e do YouTube enquanto estão no ar, e vídeos do YouTube ou arquivos seus de até 10 horas." },
  { q: "Roda em qual sistema?", a: "Windows 10 e 11 (64 bits). O Kortes é um programa: os vídeos são processados no seu computador." },
  { q: "E a transcrição das legendas?", a: "Usa a sua chave da AssemblyAI, se você tiver uma, ou o Whisper direto no seu PC, sem custo." },
  { q: "Como recebo as novidades?", a: "O Kortes se atualiza sozinho. Os avisos da equipe aparecem em Novidades, dentro do app." },
  { q: "E se eu precisar de ajuda?", a: "O botão de mensagens dentro do Kortes fala direto com a equipe. A resposta chega ali mesmo." },
];

export default function Home() {
  return (
    <main className={`lp ${syne.variable} ${geist.variable}`}>
      <div className="lp-bg" aria-hidden>
        <i /><i /><i />
      </div>

      <header className="lp-nav">
        <a href="#" className="lp-logo"><Scissors /> Kortes</a>
        <nav>
          <a href="#ao-vivo">Ao vivo</a>
          <a href="#como-funciona">Como funciona</a>
          <a href="#recursos">Recursos</a>
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
              <span className="lp-step-n">{s.n}</span>
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
            <h3>Enquadramento automático</h3>
            <p>Acha a webcam do streamer e monta o 9:16: rosto em cima, jogo embaixo, centralizado.</p>
            <div className="lp-frame-demo" aria-hidden>
              <div className="lp-fd-src"><i className="lp-fd-cam" /><i className="lp-fd-game" /></div>
              <span className="lp-fd-arrow">→</span>
              <div className="lp-fd-phone"><i /><i /></div>
            </div>
          </article>
          <article className="lp-glass lp-tile lp-reveal">
            <h3>Legenda palavra a palavra</h3>
            <p className="lp-caption-demo"><span>O QUE É</span> <b>ISSO?</b></p>
          </article>
          <article className="lp-glass lp-tile lp-reveal">
            <h3>Título que prende</h3>
            <p>A IA escreve o gancho do topo nos primeiros segundos de cada corte.</p>
          </article>
          <article className="lp-glass lp-tile lp-reveal">
            <h3>Ajustar escrevendo</h3>
            <p className="lp-type-demo">começa 3 s antes</p>
            <p>A IA refaz o corte do jeito que você pediu.</p>
          </article>
          <article className="lp-glass lp-tile lp-reveal">
            <h3>Twitch, Kick e YouTube</h3>
            <p>Lives no ar e vídeos de até 10 horas.</p>
          </article>
          <article className="lp-glass lp-tile lp-reveal">
            <h3>No seu computador</h3>
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
        <div className="lp-cta-row">
          <a className="lp-btn" href={DOWNLOAD_URL}>Baixar para Windows</a>
        </div>
        <p className="lp-small">Windows 10 e 11 · 64 bits · a licença é ativada no primeiro uso</p>
      </section>

      <footer className="lp-footer">
        <span><Scissors size={20} /> Kortes</span>
        <span>© {new Date().getFullYear()} Kortes</span>
      </footer>
    </main>
  );
}
