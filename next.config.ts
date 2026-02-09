import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/lib/i18n.ts");

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-telegram-bot-api"],
};

export default withNextIntl(nextConfig);
