import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "复检工作台",
  description: "小型金属零件的图像归档、划痕复核与检测报告。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
