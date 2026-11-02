import type { Metadata, Viewport } from "next";
import "../styles/globals.css";
import { Providers } from "./providers";
import { headers } from "next/headers";
import { consoleTitle, rememberRequestHost, resolveAppConfig, type AppConfig } from "@/lib/app-config";

// The product's identity for this request, from the Worker's `vars` (OpenNext
// copies them into process.env per request), falling back to the compiled-in
// defaults (saas-console-artifact CA1); the deploy environment falls back to
// the one the host names (CA2). Server only: the client receives it through
// <Providers config>.
async function requestConfig(): Promise<AppConfig> {
  const host = (await headers()).get("host");
  rememberRequestHost(host);
  return resolveAppConfig(process.env, undefined, host);
}

export async function generateMetadata(): Promise<Metadata> {
  const config = await requestConfig();
  return {
    title: consoleTitle(config),
    description: config.productDescription,
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      title: config.productName,
      statusBarStyle: "black-translucent",
    },
  };
}

// `viewport-fit=cover` enables `env(safe-area-inset-*)` on notched devices;
// theme-color tints the mobile browser chrome to match light/dark surfaces.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

// The whole console is session-authenticated and renders nothing of value
// statically — the root Providers tree (SessionProvider, theme, CommandPalette)
// is fully client-only and trips Next.js 15's static export with
// `TypeError: Cannot read properties of undefined (reading 'url')` inside
// useMemo on every route including /_not-found. Opt the entire app out of
// static prerender at the root; per-route fixes don't help because the
// failing code paths live in the layout's Providers.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const config = await requestConfig();
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {/*
          esbuild's `keepNames` helper (`__name`) is referenced by the
          next-themes inline theme script in the @opennextjs/cloudflare build,
          but it isn't defined in the browser — so without this shim every page
          throws `ReferenceError: __name is not defined` and crashes before
          hydration. Define a no-op (returning the target) ahead of that script.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: "globalThis.__name=globalThis.__name||function(t){return t};",
          }}
        />
        <Providers config={config}>{children}</Providers>
      </body>
    </html>
  );
}
