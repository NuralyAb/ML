/** @type {import('next').NextConfig} */

// Backend URL is resolved at *runtime* (not at build time) so the same image
// works locally (BACKEND_URL=http://localhost:8000) and inside Docker Compose
// (BACKEND_URL=http://backend:8000). Avoid NEXT_PUBLIC_* here because those
// values are inlined into the JS bundle at build time and cannot be changed
// per-deployment via env.
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const backend =
      process.env.BACKEND_URL ||
      process.env.NEXT_PUBLIC_API_URL ||      // back-compat
      "http://localhost:8000";
    return [
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
    ];
  },
};

module.exports = nextConfig;
