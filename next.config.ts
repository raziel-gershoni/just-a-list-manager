import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/lib/i18n.ts");

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-telegram-bot-api"],
  // `next dev` run by a coding agent would otherwise write an AGENTS.md at the repo root.
  agentRules: false,
};

export default withNextIntl(nextConfig);
