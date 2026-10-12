/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async redirects() {
    // The old static homepage moved to /check.html; keep its legacy URL working.
    return [{ source: '/index.html', destination: '/', permanent: true }];
  },
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
  },
};

module.exports = nextConfig;
