import type { Metadata } from "next";
import "./globals.css";
import { geist, syne } from "./fonts";

export const metadata: Metadata = {
  title: "Kortes",
  description: "Cortes virais dos seus vídeos, feitos no seu computador.",
  icons: { icon: "/logo.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${syne.variable} ${geist.variable}`}>
      <body>{children}</body>
    </html>
  );
}
