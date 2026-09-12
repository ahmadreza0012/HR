import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The UI is client-rendered and the API is deployed separately. Exporting
  // static assets lets Vercel serve the frontend without running Express.
  output: "export",
};

export default nextConfig;
