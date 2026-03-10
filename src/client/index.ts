// ============================================================================
// client/index.ts — UDP Client Entry Point
// ============================================================================

import { UDPClient } from "./udp-client.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "9001", 10);

const client = new UDPClient({
  serverHost: HOST,
  serverPort: PORT,
});

// Handle Ctrl+C
process.on("SIGINT", () => {
  console.log("\n\n  📡 Received SIGINT — shutting down...");
  client.shutdown();
});

// No connect() needed — just start! (that's the beauty of UDP)
client.start();
