// ============================================================================
// server/index.ts — UDP Server Entry Point
// ============================================================================

import { UDPServer } from "./udp-server.js";

const PORT = parseInt(process.env.PORT || "9001", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Simulated packet loss rate (0-1). Set to 0.2 for 20% loss, 0 for none.
const LOSS_RATE = parseFloat(process.env.LOSS_RATE || "0");

async function main(): Promise<void> {
  const server = new UDPServer({
    port: PORT,
    host: HOST,
    simulatedLossRate: LOSS_RATE,
  });

  await server.start();

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(`\n📡 Received ${signal}`);
    server.shutdown();
    setTimeout(() => process.exit(0), 500);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start UDP server:", error);
  process.exit(1);
});
