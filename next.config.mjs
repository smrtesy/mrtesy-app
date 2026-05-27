import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Baked once at build time and inlined into the bundle, so /api/deploy-info
  // reports the actual deploy time instead of the per-request serverless boot
  // time (which resets on every cold start).
  env: {
    APP_BUILD_TIME: new Date().toISOString(),
  },
};

export default withNextIntl(nextConfig);
