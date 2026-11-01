import type { NextConfig } from "next";
const HEAVY = ["./node_modules/@sparticuz/chromium/bin/**", "./fonts/**", "./node_modules/ffmpeg-static/ffmpeg", "./node_modules/@napi-rs/canvas*/**"];
const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client", "puppeteer-core", "@sparticuz/chromium", "unpdf", "ffmpeg-static", "@napi-rs/canvas"],
  // ffmpeg-static: ~80 MB static linux-x64 ffmpeg used to cut ASR windows (src/lib/providers/clip.ts).
  // Heavy binaries (Chromium ~67 MB, ffmpeg ~77 MB, canvas ~32 MB) ONLY for the functions that run the
  // pipeline (ASR clip, figures, PDF). Previously "/api/**" + "/v1/**" copied them into all 9 functions on
  // every deploy (~1+ GB/deploy of Functions Storage).
  outputFileTracingIncludes: {
    "/v1/**": HEAVY,
    "/api/jobs/*/advance": HEAVY,
  },
};
export default nextConfig;
