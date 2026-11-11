import type { NextConfig } from "next";

// Chromium (~67 MB) + ffmpeg (~77 MB) + canvas (~32 MB). Forced into the catch-all /v1 function only —
// that is the sole route that runs ASR clip / figures / PDF. Legacy /api/** stubs are 410 and must NOT
// pull these in (they previously inflated Functions Storage by ~1 GB per deploy).
const HEAVY = [
  "./node_modules/@sparticuz/chromium/bin/**",
  "./fonts/**",
  "./node_modules/ffmpeg-static/ffmpeg",
  "./node_modules/@napi-rs/canvas*/**",
];
const HEAVY_EXCLUDE = [
  "./node_modules/@sparticuz/chromium/**",
  "./node_modules/ffmpeg-static/**",
  "./node_modules/@napi-rs/canvas/**",
  "./node_modules/puppeteer-core/**",
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client", "puppeteer-core", "@sparticuz/chromium", "unpdf", "ffmpeg-static", "@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/v1/**": HEAVY,
  },
  // Keep retired /api stubs and other light entrypoints from absorbing pipeline binaries via shared imports.
  outputFileTracingExcludes: {
    "/api/**": HEAVY_EXCLUDE,
  },
};
export default nextConfig;
