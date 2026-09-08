import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    "https://drevo-family-archive-xekep.gripango.chatgpt.site",
  ),
  title: "Древо — история начинается с семьи",
  description:
    "Семейная история на карте времени. Люди, поколения и связи, которые нас объединяют.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "Древо — история начинается с семьи",
    description: "Люди, поколения и связи, которые нас объединяют.",
    locale: "ru_RU",
    type: "website",
    images: [
      {
        url: "https://drevo-family-archive-xekep.gripango.chatgpt.site/og.png",
        width: 1672,
        height: 941,
        alt: "Древо — история начинается с семьи",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Древо — история начинается с семьи",
    description: "Люди, поколения и связи, которые нас объединяют.",
    images: ["https://drevo-family-archive-xekep.gripango.chatgpt.site/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
