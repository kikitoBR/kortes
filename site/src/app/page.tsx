// The landing page comes later; for now the domain shows the name.
export default function Home() {
  return (
    <main className="soon">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="" width={72} height={72} />
      <h1>Kortes</h1>
      <p>Cortes virais dos seus vídeos, feitos no seu computador. Em breve.</p>
    </main>
  );
}
