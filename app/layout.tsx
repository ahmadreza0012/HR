import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "کارا | سامانه حقوق و دستمزد",
  description: "مدیریت حضور، فرمول‌های پویا و پردازش شفاف حقوق و دستمزد",
  openGraph: {
    title: "کارا | سامانه حقوق و دستمزد داینامیک",
    description: "مدیریت حضور، فرمول‌های پویا و پردازش شفاف حقوق و دستمزد",
    images: ["http://localhost:3000/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "کارا | سامانه حقوق و دستمزد داینامیک",
    description: "مدیریت حضور، فرمول‌های پویا و پردازش شفاف حقوق و دستمزد",
    images: ["http://localhost:3000/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#07090c",
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="fa" dir="rtl"><body>{children}</body></html>;
}
