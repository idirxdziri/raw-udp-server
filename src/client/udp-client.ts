// ============================================================================
// udp-client.ts — Raw UDP Client Implementation
// ============================================================================
//
// BEHIND THE SCENES — UDP Client vs TCP Client:
//
// TCP Client:
//   1. socket.connect(port, host)   ← 3-way handshake (SYN/SYN-ACK/ACK)
//   2. Wait for 'connect' event     ← Connection established
//   3. socket.write(data)           ← Reliable, ordered delivery
//   4. socket.on('data')            ← Stream of bytes (need parser)
//   5. socket.end()                 ← 4-way teardown (FIN/ACK/FIN/ACK)
//
// UDP Client:
//   1. socket = createSocket()      ← No connection needed!
//   2. socket.send(data, port, host) ← Fire and forget!
//   3. socket.on('message')         ← Each event = one complete datagram
//   4. socket.close()               ← Just close (no teardown ceremony)
//
// KEY DIFFERENCES FOR THE CLIENT:
//   - No "connected" state — just send datagrams to an address
//   - No guarantee the server received our message
//   - No guarantee we'll get a response
//   - Responses can arrive out of order
//   - We must implement our own timeout and retry logic
//
// ============================================================================

import * as dgram from "node:dgram";
import * as readline from "node:readline";
import {
  type UDPMessage,
  MessageType,
  Command,
  serialize,
  deserialize,
  generateId,
  UDP_PROTOCOL,
} from "../protocol/protocol.js";

export interface UDPClientConfig {
  serverHost: string;
  serverPort: number;
}

/** Pending request waiting for a response */
interface PendingRequest {
  msg: UDPMessage;
  sentAt: number;
  timer: ReturnType<typeof setTimeout>;
  retries: number;
  resolve: (response: UDPMessage) => void;
  reject: (error: Error) => void;
}

export class UDPClient {
  private socket: dgram.Socket;
  private config: UDPClientConfig;
  private rl: readline.Interface | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private sequenceNumber: number = 0;
  private totalSent: number = 0;
  private totalReceived: number = 0;
  private totalLost: number = 0;
  private isQuitting: boolean = false;

  constructor(config: UDPClientConfig) {
    this.config = config;

    // ── Create UDP Socket ──────────────────────────────────────
    //
    // Unlike TCP where we call socket.connect() to initiate a handshake,
    // UDP just creates a socket. No connection is established.
    //
    // We don't even need to bind() on the client — the OS will
    // automatically assign an ephemeral port when we first send().
    //
    this.socket = dgram.createSocket("udp4");

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // ── Message Received ────────────────────────────────────────
    //
    // Unlike TCP's 'data' event (which gives us arbitrary byte chunks),
    // UDP's 'message' event gives us EXACTLY ONE complete datagram.
    //
    // This means:
    //   ✅ No need for MessageParser class
    //   ✅ No framing/delimiter issues
    //   ✅ Each message is independent
    //   ❌ But it might be a response to an OLD request
    //   ❌ Or we might never receive a response at all
    //
    this.socket.on("message", (data: Buffer, rinfo: dgram.RemoteInfo) => {
      this.totalReceived++;

      const msg = deserialize(data);
      if (!msg) {
        console.log(`\n  ⚠️  Received invalid datagram (${data.length} bytes)`);
        this.rl?.prompt();
        return;
      }

      // Calculate RTT if we have the original request
      const rtt = Date.now() - msg.timestamp;

      if (msg.type === MessageType.RESPONSE || msg.type === MessageType.ERROR) {
        this.displayResponse(msg, rtt);
      } else if (msg.type === MessageType.SERVER_EVENT) {
        console.log(`\n  📢 [SERVER EVENT] ${msg.payload}`);
      }

      this.rl?.prompt();
    });

    this.socket.on("error", (error: Error) => {
      console.error(`\n  ❌ Socket error: ${error.message}`);
    });
  }

  /**
   * Start the interactive client.
   *
   * Notice: No connect() needed! With UDP, we can start sending
   * datagrams immediately. There's no handshake, no connection setup.
   * We don't even know if the server is running until we get (or don't get)
   * a response.
   */
  start(): void {
    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║          📡 RAW UDP CLIENT                          ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(
      `║  Server: ${this.config.serverHost}:${this.config.serverPort}`.padEnd(
        55,
      ) + "║",
    );
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log("║  BTS: No connection to establish!                   ║");
    console.log("║  • TCP needs a 3-way handshake before sending data  ║");
    console.log("║  • UDP just sends datagrams — fire and forget!      ║");
    console.log("║  • We don't know if the server is even running...   ║");
    console.log("║  • We'll only find out when we don't get a response ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log("║  Commands:                                          ║");
    console.log("║    PING           — measure round-trip time         ║");
    console.log("║    ECHO <msg>     — echo back a message             ║");
    console.log("║    TIME           — get server time                 ║");
    console.log("║    INFO           — server & connection stats       ║");
    console.log("║    LOSSY_ECHO <m> — 50% chance response is dropped  ║");
    console.log("║    STATS          — show client-side packet stats   ║");
    console.log("║    QUIT           — stop the client                 ║");
    console.log("╚══════════════════════════════════════════════════════╝\n");

    this.startPrompt();
  }

  private startPrompt(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "udp> ",
    });

    this.rl.prompt();

    this.rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this.rl?.prompt();
        return;
      }

      this.processInput(trimmed);
    });

    this.rl.on("close", () => {
      if (!this.isQuitting) {
        this.shutdown();
      }
    });
  }

  private processInput(input: string): void {
    // Parse command and args
    const spaceIndex = input.indexOf(" ");
    const commandStr = (
      spaceIndex === -1 ? input : input.substring(0, spaceIndex)
    ).toUpperCase();
    const args = spaceIndex === -1 ? "" : input.substring(spaceIndex + 1);

    // Local-only commands
    if (commandStr === "STATS") {
      this.showStats();
      this.rl?.prompt();
      return;
    }

    if (commandStr === "QUIT") {
      this.sendCommand(Command.QUIT, "");
      setTimeout(() => this.shutdown(), 500);
      return;
    }

    // Map to Command enum
    const commandMap: Record<string, Command> = {
      PING: Command.PING,
      ECHO: Command.ECHO,
      TIME: Command.TIME,
      INFO: Command.INFO,
      LOSSY_ECHO: Command.LOSSY_ECHO,
    };

    const command = commandMap[commandStr];
    if (!command) {
      console.log(
        `  ❓ Unknown command: "${commandStr}". Try: PING, ECHO, TIME, INFO, LOSSY_ECHO, STATS, QUIT`,
      );
      this.rl?.prompt();
      return;
    }

    this.sendCommand(command, args);
  }

  /**
   * Send a command as a UDP datagram.
   *
   * BEHIND THE SCENES:
   *
   * socket.send(buffer, port, address) triggers:
   *   1. sendto() syscall → kernel
   *   2. Kernel adds UDP header (8 bytes):
   *      ┌─────────┬─────────┬────────┬──────────┐
   *      │ Src Port │ Dst Port│ Length │ Checksum │
   *      │ (auto)   │ 9001   │ N+8   │ computed │
   *      └─────────┴─────────┴────────┴──────────┘
   *   3. Kernel adds IP header (20 bytes)
   *   4. Kernel does ARP/NDP for next-hop MAC address
   *   5. NIC sends Ethernet frame
   *
   * Total overhead: 42 bytes (14 Eth + 20 IP + 8 UDP) per datagram
   *
   * If the server isn't running, the datagram is sent anyway!
   * The remote kernel will reply with ICMP "Port Unreachable",
   * but our socket MAY or MAY NOT surface this error.
   */
  private sendCommand(command: Command, payload: string): void {
    this.sequenceNumber++;

    const msg: UDPMessage = {
      id: generateId(),
      type: MessageType.REQUEST,
      command,
      payload,
      timestamp: Date.now(),
      seq: this.sequenceNumber,
    };

    const buffer = serialize(msg);

    console.log(
      `  📤 Sending: ${command} ${payload ? `"${payload}" ` : ""}` +
        `(${buffer.length} bytes, seq:${this.sequenceNumber})`,
    );
    console.log(
      `     BTS: sendto(fd, buffer, ${this.config.serverPort}, "${this.config.serverHost}") — fire and forget!`,
    );

    this.socket.send(
      buffer,
      0,
      buffer.length,
      this.config.serverPort,
      this.config.serverHost,
      (error) => {
        if (error) {
          console.log(`  ❌ Send error: ${error.message}`);
          this.rl?.prompt();
          return;
        }
        this.totalSent++;
      },
    );

    // ── Timeout Detection ──────────────────────────────────────
    //
    // With TCP, if data is lost, the kernel handles retransmission.
    // With UDP, data loss is SILENT. We have to detect it ourselves.
    //
    // Strategy: Set a timer after sending. If no response arrives
    // before the timer fires, assume the datagram (or response) was lost.
    //
    const timeoutTimer = setTimeout(() => {
      this.totalLost++;
      console.log(
        `\n  ⏰ TIMEOUT: No response for ${command} (seq:${msg.seq}) after ${UDP_PROTOCOL.RESPONSE_TIMEOUT}ms`,
      );
      console.log(`     BTS: The datagram could have been lost at ANY point:`);
      console.log(`     • Our outgoing datagram was dropped by a router`);
      console.log(`     • Server received it but crashed before responding`);
      console.log(`     • Server responded but the RESPONSE was dropped`);
      console.log(`     • Server is not running (ICMP Port Unreachable)`);
      console.log(`     We simply cannot know which one happened!`);
      this.rl?.prompt();
    }, UDP_PROTOCOL.RESPONSE_TIMEOUT);

    // Store pending request so we can cancel timeout on response
    this.pendingRequests.set(msg.id, {
      msg,
      sentAt: Date.now(),
      timer: timeoutTimer,
      retries: 0,
      resolve: () => {},
      reject: () => {},
    });
  }

  /**
   * Display a server response
   */
  private displayResponse(msg: UDPMessage, rtt: number): void {
    const icon = msg.type === MessageType.ERROR ? "❌" : "✅";
    console.log(`\n  ${icon} [${msg.type}] ${msg.payload}`);
    console.log(`     RTT: ${rtt}ms (time for datagram round-trip)`);

    // Cancel any pending timeout for this response
    // Note: We can't perfectly match request to response in this simple
    // protocol, so we just clear the oldest pending request
    if (this.pendingRequests.size > 0) {
      const [firstKey, firstReq] = this.pendingRequests.entries().next().value!;
      clearTimeout(firstReq.timer);
      this.pendingRequests.delete(firstKey);
    }
  }

  /**
   * Show client-side packet statistics
   */
  private showStats(): void {
    const lossRate =
      this.totalSent > 0
        ? ((this.totalLost / this.totalSent) * 100).toFixed(1)
        : "0.0";

    console.log("\n  ╔════════════════════════════════════════╗");
    console.log("  ║         📊 Client Packet Stats         ║");
    console.log("  ╠════════════════════════════════════════╣");
    console.log(`  ║  Datagrams Sent:     ${this.totalSent}`.padEnd(43) + "║");
    console.log(
      `  ║  Responses Received: ${this.totalReceived}`.padEnd(43) + "║",
    );
    console.log(`  ║  Timeouts (lost):    ${this.totalLost}`.padEnd(43) + "║");
    console.log(`  ║  Packet Loss Rate:   ${lossRate}%`.padEnd(43) + "║");
    console.log("  ╠════════════════════════════════════════╣");
    console.log("  ║  Note: Loss can happen in either       ║");
    console.log("  ║  direction (request OR response)       ║");
    console.log("  ╚════════════════════════════════════════╝");
  }

  /**
   * Shutdown the client.
   *
   * Unlike TCP, there's NO teardown handshake:
   *   TCP: FIN → ACK → FIN → ACK (4 packets, multiple RTTs)
   *   UDP: close() → done (instant)
   *
   * The server won't even know we disconnected unless we tell it.
   */
  shutdown(): void {
    this.isQuitting = true;

    // Cancel all pending timeouts
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
    }
    this.pendingRequests.clear();

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    console.log("\n  📊 Final stats:");
    console.log(
      `     Sent: ${this.totalSent} | Received: ${this.totalReceived} | Lost: ${this.totalLost}`,
    );
    console.log("  👋 Closing UDP socket (no teardown handshake needed!)");

    this.socket.close(() => {
      process.exit(0);
    });
  }
}
