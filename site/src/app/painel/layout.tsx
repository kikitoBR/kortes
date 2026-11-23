import type { Metadata } from "next";

export const metadata: Metadata = { title: "Painel · Kortes", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function PainelLayout({ children }: { children: React.ReactNode }) {
  return children;
}
