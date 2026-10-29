import type { NextConfig } from "next";

// The console and API face the internet (through the public door and Vercel),
// so every response says: no framing, no guessing content types, HTTPS only,
// no camera, microphone or location (bar the console's microphone, below).
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // The console's page may ask for the microphone: its Playground
      // records for speech to text. A later rule's header replaces the one
      // above, and the browser still asks the user before opening the mic.
      {
        source: "/",
        headers: [{ key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" }],
      },
    ];
  },
};

export default nextConfig;
