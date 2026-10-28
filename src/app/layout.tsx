export const metadata = { title: "Lecture Summarizer API" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body style={{ fontFamily: "sans-serif" }}>{children}</body></html>;
}
