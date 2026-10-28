import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client", "puppeteer-core", "@sparticuz/chromium", "unpdf"],
  // Ship the brotli Chromium pack + embedded Hebrew fonts with the functions that render PDFs.
  outputFileTracingIncludes: {
    "/v1/**": ["./node_modules/@sparticuz/chromium/bin/**", "./fonts/**"],
    "/api/**": ["./node_modules/@sparticuz/chromium/bin/**", "./fonts/**"],
  },
};
export default nextConfig;
