import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Thun Murex", template: "%s · Thun Murex" },
  description: "Thun Murex: an AI gateway with cloud APIs and local agent CLIs behind one endpoint.",
  applicationName: "Thun Murex",
};

// Runs before first paint so a saved Light/Dark choice doesn't flash the
// other theme. "System" stores nothing and lets prefers-color-scheme decide.
const THEME_SCRIPT = `try{var t=localStorage.getItem("ai-thun-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
