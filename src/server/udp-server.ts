// ============================================================================
// udp-server.ts — Raw UDP Server Implementation
// ============================================================================
//
// BEHIND THE SCENES — How a UDP "server" works vs TCP:
//
// TCP Server:                          UDP Server:
// ─────────────                        ─────────────
// 1. socket()                          1. socket()
// 2. bind()                            2. bind()
// 3. listen()    ← NO EQUIVALENT      (doesn't exist in UDP)
// 4. accept()    ← NO EQUIVALENT      (doesn't exist in UDP)
// 5. recv/send per client socket       3. recvfrom/sendto on SAME socket
//
// KEY DIFFERENCE:
// • TCP: One socket per client connection (accept() creates new file descriptor (fd))
// • UDP: ONE socket for ALL clients (no connections, just datagrams)
//
// In TCP, after accept(), each client gets its own socket with its own
// buffer and state. In UDP, there is ONLY ONE socket. The server must
// identify clients by their (address, port) pair in each datagram.
//
// ┌──────────┐  dgram  ┌──────────┐
// │ Client A │ ──────→ │          │
// │ :50001   │         │  UDP     │   ONE socket
// ├──────────┤ dgram   │  Server  │   handles ALL
// │ Client B │ ──────→ │  :9001   │   clients
// │ :50002   │         │          │
// ├──────────┤ dgram   │          │
// │ Client C │ ──────→ │          │
// │ :50003   │         └──────────┘
// └──────────┘
//
// SYSTEM CALLS:
// Node.js dgram module maps to these system calls:
//   dgram.createSocket('udp4') → socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
//   server.bind(port)          → bind(fd, {addr, port})
//   server.on('message')       → recvfrom(fd, buffer, flags, &srcAddr)
//   server.send(msg, port, addr) → sendto(fd, buffer, flags, dstAddr)
//
// Note: No listen(), no accept(). UDP is inherently simpler.
//
// ============================================================================

import * as dgram from "node:dgram";
import {
  type UDPMessage,
  MessageType,
  Command,
  serialize,
  deserialize,
  createResponse,
  generateId,
  UDP_PROTOCOL,
} from "../protocol/protocol.js";

/** Track "known" clients (even though there's no real connection) */
interface ClientInfo {
  address: string;
  port: number;
  firstSeen: Date;
  lastSeen: Date;
  datagramsReceived: number;
  datagramsSent: number;
  bytesReceived: number;
  bytesSent: number;
}

export interface UDPServerConfig {
  port: number;
  host: string;
  /** Probability (0-1) of dropping incoming datagrams to simulate loss */
  simulatedLossRate: number;
}

export class UDPServer {
  private socket: dgram.Socket;
  private config: UDPServerConfig;
  private clients: Map<string, ClientInfo> = new Map();
  private totalDatagramsReceived: number = 0;
  private totalDatagramsSent: number = 0;
  private totalDatagramsDropped: number = 0;
  private startTime: Date = new Date();

  constructor(config: UDPServerConfig) {
    this.config = config;

    // ── Create UDP Socket ──────────────────────────────────────
    //
    // dgram.createSocket('udp4') does:
    //   1. socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
    //      - AF_INET: IPv4
    //      - SOCK_DGRAM: Datagram socket (UDP)
    //      - IPPROTO_UDP: UDP protocol (17)
    //
    // 'udp4' = IPv4, 'udp6' = IPv6
    //
    // reuseAddr: true allows multiple processes to bind the same port.
    // This is useful for:
    //   - Cluster mode (multiple workers sharing the port)
    //   - Quick restart (avoid EADDRINUSE after recent close)
    //
    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // ── Error Handling ──────────────────────────────────────────
    this.socket.on("error", (error: Error) => {
      const errCode = (error as NodeJS.ErrnoException).code;
      if (errCode === "EADDRINUSE") {
        console.error(`\n❌ Port ${this.config.port} is already in use!`);
      } else if (errCode === "EACCES") {
        console.error(`\n❌ Permission denied for port ${this.config.port}`);
      } else {
        console.error(`\n❌ Socket error: ${error.message}`);
      }
      this.socket.close();
      process.exit(1);
    });

    // ── Message Received ────────────────────────────────────────
    //
    // BEHIND THE SCENES — What happens when a datagram arrives:
    //
    // 1. NIC receives Ethernet frame
    // 2. Kernel strips Ethernet header → IP packet
    // 3. Kernel checks IP header → dest is us, protocol = UDP (17)
    // 4. Kernel strips IP header → UDP datagram
    // 5. Kernel checks UDP header → dest port matches our bound port
    // 6. Kernel places datagram in socket receive buffer
    // 7. epoll/kqueue notifies libuv → 'message' event fires
    //
    // CRITICAL DIFFERENCE FROM TCP:
    // - Each 'message' event = EXACTLY ONE complete datagram
    // - No need for stream parsing or message framing!
    // - BUT: datagrams can arrive out of order, be duplicated, or be lost
    //
    // The 'rinfo' (Remote Info) parameter tells us WHO sent the datagram:
    //   rinfo.address = sender's IP
    //   rinfo.port = sender's ephemeral port
    //   rinfo.size = datagram size in bytes
    //
    this.socket.on("message", (data: Buffer, rinfo: dgram.RemoteInfo) => {
      this.totalDatagramsReceived++;

      // ── Simulate Packet Loss ────────────────────────────────
      //
      // In real networks, UDP packets are lost due to:
      //   - Router buffer overflow (congestion)
      //   - Checksum failure (corruption)
      //   - TTL expiration (routing loops)
      //   - Firewall drops
      //   - NIC receive buffer overflow
      //
      // We simulate this to demonstrate UDP's unreliable nature.
      //
      if (
        this.config.simulatedLossRate > 0 &&
        Math.random() < this.config.simulatedLossRate
      ) {
        this.totalDatagramsDropped++;
        console.log(
          `  💀 SIMULATED LOSS: Dropped datagram from ${rinfo.address}:${rinfo.port} ` +
            `(${data.length} bytes) — Drop rate: ${(this.config.simulatedLossRate * 100).toFixed(0)}%`,
        );
        return; // Just ignore the datagram — like it never arrived
      }

      // Track this client
      const clientKey = `${rinfo.address}:${rinfo.port}`;
      this.trackClient(clientKey, rinfo, data.length);

      // Parse the datagram
      const msg = deserialize(data);
      if (!msg) {
        console.log(
          `  ⚠️  Invalid datagram from ${clientKey} (${data.length} bytes)`,
        );
        this.sendError(rinfo, "Invalid datagram format");
        return;
      }

      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] 📥 DATAGRAM from ${clientKey} — ` +
          `${msg.type}:${msg.command || ""} (${data.length} bytes, id:${msg.id})`,
      );

      // Handle the message
      this.handleMessage(msg, rinfo);
    });

    // ── Listening ───────────────────────────────────────────────
    this.socket.on("listening", () => {
      const addr = this.socket.address();

      console.log("\n╔══════════════════════════════════════════════════════╗");
      console.log("║          📡 RAW UDP SERVER — Behind the Scenes      ║");
      console.log("╠══════════════════════════════════════════════════════╣");
      console.log(
        `║  Listening on: ${addr.address}:${addr.port}`.padEnd(55) + "║",
      );
      console.log(`║  Protocol: UDP (SOCK_DGRAM)`.padEnd(55) + "║");
      console.log(
        `║  Simulated loss rate: ${(this.config.simulatedLossRate * 100).toFixed(0)}%`.padEnd(
          55,
        ) + "║",
      );
      console.log("╠══════════════════════════════════════════════════════╣");
      console.log("║  BTS: What happened:                                ║");
      console.log("║  1. socket(AF_INET, SOCK_DGRAM, UDP) → fd          ║");
      console.log(
        `║  2. bind(fd, ${addr.address}:${addr.port})`.padEnd(55) + "║",
      );
      console.log("║  3. Ready! (No listen() or accept() needed!)        ║");
      console.log("║                                                     ║");
      console.log("║  vs TCP which needs: socket→bind→listen→accept      ║");
      console.log("║  UDP just needs:    socket→bind → done!             ║");
      console.log("╠══════════════════════════════════════════════════════╣");
      console.log("║  Key UDP facts:                                     ║");
      console.log("║  • No connections — each datagram is independent    ║");
      console.log("║  • No handshake — zero latency overhead             ║");
      console.log("║  • No guaranteed delivery — datagrams can be lost   ║");
      console.log("║  • No ordering — datagrams can arrive out of order  ║");
      console.log("║  • Message boundaries preserved (unlike TCP!)       ║");
      console.log("╠══════════════════════════════════════════════════════╣");
      console.log("║  Waiting for datagrams...                           ║");
      console.log("║  Press Ctrl+C to stop                               ║");
      console.log("╚══════════════════════════════════════════════════════╝\n");
    });
  }

  /**
   * Start the server by binding to the configured port.
   *
   * BEHIND THE SCENES:
   * Unlike TCP which needs socket() → bind() → listen() → accept(),
   * UDP only needs socket() → bind(). That's it!
   *
   * After bind(), the kernel will deliver any UDP datagram arriving
   * at our port to our socket's receive buffer.
   *
   * There are NO connection queues (SYN queue, accept queue).
   * There is just ONE receive buffer for ALL incoming datagrams.
   * If the buffer is full, new datagrams are SILENTLY DROPPED.
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.bind(this.config.port, this.config.host, () => {
        this.startTime = new Date();

        // Set receive buffer size (OS default is usually 128KB-256KB)
        // Larger buffer = less packet loss under high load
        try {
          this.socket.setRecvBufferSize(1024 * 1024); // 1MB
          console.log("  📐 Recv buffer set to 1MB");
        } catch {
          console.log("  📐 Using default recv buffer size");
        }

        resolve();
      });
    });
  }

  /**
   * Handle an incoming message and route to command handler
   */
  private handleMessage(msg: UDPMessage, rinfo: dgram.RemoteInfo): void {
    if (msg.type !== MessageType.REQUEST) {
      return; // Server only handles requests
    }

    switch (msg.command) {
      case Command.PING:
        this.handlePing(msg, rinfo);
        break;

      case Command.ECHO:
        this.handleEcho(msg, rinfo);
        break;

      case Command.TIME:
        this.handleTime(msg, rinfo);
        break;

      case Command.INFO:
        this.handleInfo(msg, rinfo);
        break;

      case Command.LOSSY_ECHO:
        this.handleLossyEcho(msg, rinfo);
        break;

      case Command.QUIT:
        this.handleQuit(msg, rinfo);
        break;

      default:
        this.sendError(rinfo, `Unknown command: ${msg.command}`);
    }
  }

  // ── Command Handlers ──────────────────────────────────────────

  private handlePing(msg: UDPMessage, rinfo: dgram.RemoteInfo): void {
    // Simple PONG — measures RTT (round-trip time)
    // In TCP, RTT is measured at the kernel level for retransmission timing.
    // In UDP, we must measure it ourselves!
    const response: UDPMessage = {
      id: generateId(),
      type: MessageType.RESPONSE,
      payload: "PONG",
      timestamp: Date.now(),
    };
    this.sendDatagram(response, rinfo);
  }

  private handleEcho(msg: UDPMessage, rinfo: dgram.RemoteInfo): void {
    if (!msg.payload) {
      this.sendError(rinfo, "ECHO requires a payload");
      return;
    }
    const response: UDPMessage = {
      id: generateId(),
      type: MessageType.RESPONSE,
      payload: msg.payload,
      timestamp: Date.now(),
    };
    this.sendDatagram(response, rinfo);
  }

  private handleTime(msg: UDPMessage, rinfo: dgram.RemoteInfo): void {
    const response: UDPMessage = {
      id: generateId(),
      type: MessageType.RESPONSE,
      payload: new Date().toISOString(),
      timestamp: Date.now(),
    };
    this.sendDatagram(response, rinfo);
  }

  private handleInfo(msg: UDPMessage, rinfo: dgram.RemoteInfo): void {
    const clientKey = `${rinfo.address}:${rinfo.port}`;
    const client = this.clients.get(clientKey);
    const uptime = ((Date.now() - this.startTime.getTime()) / 1000).toFixed(0);

    const info = [
      `Server Uptime: ${uptime}s`,
      `Known Clients: ${this.clients.size}`,
      `Total Datagrams In: ${this.totalDatagramsReceived}`,
      `Total Datagrams Out: ${this.totalDatagramsSent}`,
      `Total Dropped (simulated): ${this.totalDatagramsDropped}`,
      client
        ? `Your Datagrams In/Out: ${client.datagramsReceived}/${client.datagramsSent}`
        : "",
    ]
      .filter(Boolean)
      .join(" | ");

    const response: UDPMessage = {
      id: generateId(),
      type: MessageType.RESPONSE,
      payload: info,
      timestamp: Date.now(),
    };
    this.sendDatagram(response, rinfo);
  }

  /**
   * LOSSY_ECHO — intentionally drops some responses to demonstrate
   * that the client never knows if the server received the datagram
   * or if the response was lost.
   *
   * In TCP, if data is lost, the kernel automatically retransmits.
   * In UDP, the application must handle this itself!
   */
  private handleLossyEcho(msg: UDPMessage, rinfo: dgram.RemoteInfo): void {
    // Drop 50% of responses randomly
    if (Math.random() < 0.5) {
      console.log(
        `  💀 LOSSY_ECHO: Intentionally dropping response to ${rinfo.address}:${rinfo.port}`,
      );
      return; // Don't respond — the client will timeout
    }

    const response: UDPMessage = {
      id: generateId(),
      type: MessageType.RESPONSE,
      payload: msg.payload || "(empty)",
      timestamp: Date.now(),
    };
    this.sendDatagram(response, rinfo);
  }

  private handleQuit(msg: UDPMessage, rinfo: dgram.RemoteInfo): void {
    const response: UDPMessage = {
      id: generateId(),
      type: MessageType.RESPONSE,
      payload: "Goodbye! (Note: in UDP there's no connection to close!)",
      timestamp: Date.now(),
    };
    this.sendDatagram(response, rinfo);

    // Remove client from tracking
    const clientKey = `${rinfo.address}:${rinfo.port}`;
    this.clients.delete(clientKey);
    console.log(
      `  👋 Client ${clientKey} said goodbye (removed from tracking)`,
    );
  }

  // ── Send Helpers ──────────────────────────────────────────────

  /**
   * Send a datagram to a client.
   *
   * BEHIND THE SCENES:
   * socket.send(buffer, port, address) maps to:
   *   sendto(fd, buffer, len, flags, destAddr, addrLen)
   *
   * Unlike TCP's write():
   *   - NO connection needed — just specify destination each time
   *   - NO buffering/Nagle — each send() = exactly one datagram
   *   - NO ACK — we don't know if it arrived (fire and forget!)
   *   - NO flow control — we can send as fast as we want
   *   - NO ordering guarantee — datagrams may arrive out of order
   *
   * The kernel:
   *   1. Adds UDP header (src port, dst port, length, checksum)
   *   2. Adds IP header (src IP, dst IP, TTL=64, protocol=17)
   *   3. Performs ARP lookup for dst MAC (or uses gateway MAC)
   *   4. Sends the Ethernet frame
   *
   * If the send buffer is full, send() returns an error immediately
   * (EAGAIN/EWOULDBLOCK). Unlike TCP, there's no waiting/backpressure.
   */
  private sendDatagram(msg: UDPMessage, rinfo: dgram.RemoteInfo): void {
    const buffer = serialize(msg);

    this.socket.send(
      buffer,
      0,
      buffer.length,
      rinfo.port,
      rinfo.address,
      (error) => {
        if (error) {
          console.error(
            `  ❌ Send error to ${rinfo.address}:${rinfo.port}: ${error.message}`,
          );
          return;
        }

        this.totalDatagramsSent++;

        // Track bytes sent to this client
        const clientKey = `${rinfo.address}:${rinfo.port}`;
        const client = this.clients.get(clientKey);
        if (client) {
          client.datagramsSent++;
          client.bytesSent += buffer.length;
        }

        console.log(
          `  📤 DATAGRAM to ${rinfo.address}:${rinfo.port} — ` +
            `${msg.type} (${buffer.length} bytes, id:${msg.id})`,
        );
      },
    );
  }

  private sendError(rinfo: dgram.RemoteInfo, message: string): void {
    const response: UDPMessage = {
      id: generateId(),
      type: MessageType.ERROR,
      payload: message,
      timestamp: Date.now(),
    };
    this.sendDatagram(response, rinfo);
  }

  // ── Client Tracking ───────────────────────────────────────────
  //
  // Since UDP has NO connections, the server has NO built-in way
  // to know which clients are "connected". We track clients manually
  // using their (address, port) pair, which is included in every
  // datagram's rinfo.
  //
  // This is different from TCP where each accept() gives us a
  // dedicated socket for each client.
  //
  private trackClient(
    key: string,
    rinfo: dgram.RemoteInfo,
    bytes: number,
  ): void {
    const existing = this.clients.get(key);
    if (existing) {
      existing.lastSeen = new Date();
      existing.datagramsReceived++;
      existing.bytesReceived += bytes;
    } else {
      console.log(`  🆕 New client: ${key}`);
      this.clients.set(key, {
        address: rinfo.address,
        port: rinfo.port,
        firstSeen: new Date(),
        lastSeen: new Date(),
        datagramsReceived: 1,
        datagramsSent: 0,
        bytesReceived: bytes,
        bytesSent: 0,
      });
    }
  }

  /**
   * Graceful shutdown.
   *
   * BEHIND THE SCENES:
   * Unlike TCP, there's no graceful close sequence (no FIN/ACK dance).
   * We just close the socket. Any datagrams in the receive buffer are lost.
   * Any datagrams in transit are... well, they'll arrive at a closed port
   * and the kernel will respond with an ICMP "Port Unreachable" message.
   */
  shutdown(): void {
    console.log("\n  🛑 Shutting down UDP server...");
    console.log(
      `  📊 Stats: Received: ${this.totalDatagramsReceived} | Sent: ${this.totalDatagramsSent} | Dropped: ${this.totalDatagramsDropped}`,
    );
    console.log(`  👥 Clients served: ${this.clients.size}`);

    this.socket.close(() => {
      console.log("  ✅ UDP socket closed\n");
    });
  }
}
