import type { NextConfig } from "next";

// No `output: "standalone"` here: this repo runs a custom server (server.ts, for
// Socket.IO — see docs/adr/0001-self-hosted-deployment.md), and Next's standalone
// output doesn't trace custom server files (see its own custom-server docs).
const nextConfig: NextConfig = {};

export default nextConfig;
