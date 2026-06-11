import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Don't bundle the ffmpeg binary package — require it from node_modules at runtime
  // so its binary path resolves correctly (used by /api/ffmpeg).
  serverExternalPackages: ["ffmpeg-static"],
};

export default nextConfig;
