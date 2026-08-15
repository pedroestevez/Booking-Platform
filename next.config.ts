import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The booking app is designed to be embedded in customer sites via an
  // iframe. We deliberately do NOT send X-Frame-Options: DENY; instead we
  // allow framing and (in a later milestone) will scope frame-ancestors to
  // each tenant's verified domain via the Content-Security-Policy.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
