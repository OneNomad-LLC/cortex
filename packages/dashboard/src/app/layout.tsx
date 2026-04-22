import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cortex",
  description: "Your work-knowledge dashboard.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        {children}
      </body>
    </html>
  );
}
