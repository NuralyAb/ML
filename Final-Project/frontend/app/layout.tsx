import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Med Forecast KZ — прогноз рецептов МЗ РК",
  description:
    "ML-система прогнозирования объёмов выписки рецептов по регионам, районам и диагнозам Республики Казахстан.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap"
        />
      </head>
      <body className="font-sans antialiased min-h-screen bg-paper text-ink-900">{children}</body>
    </html>
  );
}
