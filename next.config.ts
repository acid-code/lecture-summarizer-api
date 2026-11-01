import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client", "puppeteer-core", "@sparticuz/chromium", "unpdf", "ffmpeg-static", "@napi-rs/canvas"],
  // ffmpeg-static: ~80 MB static linux-x64 ffmpeg used to cut ASR windows (src/lib/providers/clip.ts).
  // Ship the brotli Chromium pack + embedded Hebrew fonts with the functions that render PDFs.
  outputFileTracingIncludes: {
    "/v1/**": ["./node_modules/@sparticuz/chromium/bin/**", "./fonts/**", "./node_modules/ffmpeg-static/ffmpeg", "./node_modules/@napi-rs/canvas*/**"],
    "/api/**": ["./node_modules/@sparticuz/chromium/bin/**", "./fonts/**", "./node_modules/ffmpeg-static/ffmpeg", "./node_modules/@napi-rs/canvas*/**"],
  },
};
export default nextConfig;
