import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client", "puppeteer-core", "unpdf"],
};
export default nextConfig;
