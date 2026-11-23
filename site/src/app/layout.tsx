import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kortes",
  description: "Cortes virais dos seus vídeos, feitos no seu computador.",
  icons: { icon: "/logo.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
