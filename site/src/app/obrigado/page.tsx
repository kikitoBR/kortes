import type { Metadata } from "next";
import Link from "next/link";
import { Icon, Scissors } from "../brand";
import { DownloadButton } from "../download-button";
import { latestRelease } from "../release";

export const metadata: Metadata = {
  title: "Compra confirmada · Kortes",
  description: "Baixe o Kortes e entre com o e-mail da compra.",
  robots: { index: false },
};
export const revalidate = 3600;

/** Kirvano sends buyers here after paying (Produto → Configurações → página de obrigado). */
export default async function ThanksPage() {
  const release = await latestRelease();
  const meta = ["Windows 10 e 11 · 64 bits", release.version && `versão ${release.version}`, release.sizeMb && `${release.sizeMb} MB`]
    .filter(Boolean)
    .join(" · ");
  return (
    <main className="auth thanks">
      <div className="auth-glow" aria-hidden><i /><i /><i /></div>
      <div className="auth-box thanks-box">
        <Link href="/" className="auth-logo"><Scissors size={30} /> Kortes</Link>
        <section className="auth-card">
          <span className="auth-badge ok"><Icon name="check" size={26} /></span>
          <div className="auth-head">
            <h1>Compra confirmada!</h1>
            <p>Bem-vindo ao Kortes Pro. Faltam três passos para o seu primeiro corte sem limite.</p>
          </div>
          <ol className="thanks-steps">
            <li>
              <b>Baixe e instale o Kortes</b>
              <span>O programa é para Windows. Se você estiver no celular, abra esta página no computador.</span>
              <div className="thanks-download"><DownloadButton href={release.url} meta={meta} /></div>
            </li>
            <li>
              <b>Entre com o e-mail da compra</b>
              <span>Abra o Kortes, escolha <em>Já tenho conta</em> e digite o mesmo e-mail que você usou aqui na compra.</span>
            </li>
            <li>
              <b>Crie a sua senha</b>
              <span>No primeiro acesso o Kortes pede para você criar uma senha. Pronto: o plano Pro já aparece na sua conta.</span>
            </li>
          </ol>
          <div className="alert info">
            <Icon name="mail" size={18} />
            <span>Pagou com Pix ou boleto? O acesso libera assim que o pagamento for confirmado, em geral em poucos minutos.</span>
          </div>
        </section>
        <p className="auth-foot">
          Precisa de ajuda? No Kortes, use o botão de suporte, ou <Link href="/esqueci-senha">crie uma nova senha</Link>.
        </p>
      </div>
    </main>
  );
}
