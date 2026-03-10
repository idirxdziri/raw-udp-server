// ============================================================================
// protocol.ts — UDP Datagram Protocol Definition
// ============================================================================
//
// FUNDAMENTAL DIFFERENCE: TCP vs UDP
//
// TCP (Transmission Control Protocol):
//   ┌──────────────────────────────────────────────────────────┐
//   │ • CONNECTION-ORIENTED: Must do 3-way handshake first    │
//   │ • RELIABLE: Every byte is guaranteed to arrive           │
//   │ • ORDERED: Bytes arrive in the exact order sent          │
//   │ • STREAM: No message boundaries (just a byte stream)    │
//   │ • FLOW CONTROL: Sender adapts to receiver's speed       │
//   │ • CONGESTION CONTROL: Sender adapts to network capacity │
//   │ • OVERHEAD: ~20 bytes TCP header + handshake latency    │
//   └──────────────────────────────────────────────────────────┘
//
// UDP (User Datagram Protocol):
//   ┌──────────────────────────────────────────────────────────┐
//   │ • CONNECTIONLESS: No handshake — just send!             │
//   │ • UNRELIABLE: Packets can be lost, duplicated           │
//   │ • UNORDERED: Packets can arrive out of order            │
//   │ • DATAGRAM: Each send() is ONE discrete message         │
//   │ • NO FLOW CONTROL: Sender can overwhelm receiver       │
//   │ • NO CONGESTION CONTROL: Sender can flood the network  │
//   │ • LOW OVERHEAD: Only 8 bytes UDP header, no handshake   │
//   └──────────────────────────────────────────────────────────┘
//
// WHY WOULD ANYONE USE UDP? Because sometimes speed > reliability:
//
//   USE TCP WHEN:                    USE UDP WHEN:
//   ─────────────                    ─────────────
//   • Web pages (HTTP)               • Live video streaming
//   • File transfer (FTP)            • Online gaming
//   • Email (SMTP)                   • DNS queries
//   • Database connections           • VoIP (phone calls)
//   • API calls (REST/gRPC)          • IoT sensor data
//                                    • Real-time metrics
//
// KEY INSIGHT: UDP preserves MESSAGE BOUNDARIES!
// Unlike TCP (byte stream), each socket.send() creates exactly ONE
// datagram, and the receiver gets it as ONE message event.
// No need for delimiters or parsers like we needed in TCP!
//
// ============================================================================

/**
 * UDP Datagram format
 *
 * BEHIND THE SCENES — A UDP datagram on the wire:
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │                    UDP HEADER (8 bytes)                  │
 * ├──────────────┬──────────────┬──────────┬────────────────┤
 * │ Src Port     │ Dst Port     │ Length   │ Checksum       │
 * │ (2 bytes)    │ (2 bytes)    │ (2 bytes)│ (2 bytes)      │
 * ├──────────────┴──────────────┴──────────┴────────────────┤
 * │                    PAYLOAD (our data)                    │
 * │              (up to 65,507 bytes*)                       │
 * └─────────────────────────────────────────────────────────┘
 *
 * * Max UDP payload = 65,535 (IP max) - 20 (IP header) - 8 (UDP header)
 * * In practice, stay under 1472 bytes to avoid IP fragmentation:
 *   1500 (Ethernet MTU) - 20 (IP header) - 8 (UDP header) = 1472
 *
 * Compare to TCP header: 20-60 bytes (options can add 40 bytes)
 * UDP header: ALWAYS exactly 8 bytes. Simple!
 *
 * Checksum field:
 *   - Optional in IPv4 (0 = no checksum)
 *   - MANDATORY in IPv6
 *   - Covers header + payload + pseudo-header (src/dst IP)
 *   - If checksum fails, datagram is SILENTLY DROPPED (no error to sender!)
 */

/**
 * Our application-layer datagram format.
 *
 * Since UDP preserves message boundaries, we don't need a delimiter.
 * We encode our protocol as JSON for simplicity and readability.
 *
 * In production, you'd use a binary format (Protocol Buffers, MessagePack)
 * to minimize datagram size — every byte matters when you're sending
 * thousands of packets per second (gaming, video, etc.)
 */
export interface UDPMessage {
  /** Unique message ID — needed because UDP can duplicate/lose/reorder */
  id: string;
  /** Message type */
  type: MessageType;
  /** Command (for REQUEST type) */
  command?: Command;
  /** Payload data */
  payload: string;
  /** Timestamp for measuring RTT (round-trip time) */
  timestamp: number;
  /** Sequence number for detecting reordering & loss */
  seq?: number;
}

export enum MessageType {
  REQUEST = "REQUEST",
  RESPONSE = "RESPONSE",
  ACK = "ACK", // Optional acknowledgment (adding reliability)
  ERROR = "ERROR",
  SERVER_EVENT = "SERVER_EVENT",
}

export enum Command {
  PING = "PING",
  ECHO = "ECHO",
  TIME = "TIME",
  INFO = "INFO",
  QUIT = "QUIT",
  /** Special: simulates packet loss to demonstrate UDP unreliability */
  LOSSY_ECHO = "LOSSY_ECHO",
}

/**
 * Serialize a UDPMessage to bytes for sending over the network.
 *
 * BEHIND THE SCENES:
 * socket.send(buffer) → kernel wraps our payload:
 *   1. Add UDP header (8 bytes: src port, dst port, length, checksum)
 *   2. Add IP header (20 bytes: src IP, dst IP, TTL, protocol=17 for UDP)
 *   3. Add Ethernet header (14 bytes: src MAC, dst MAC, type)
 *   4. Send the frame out the NIC
 *
 * Total overhead per datagram: ~42 bytes of headers for our payload
 */
export function serialize(msg: UDPMessage): Buffer {
  const json = JSON.stringify(msg);
  return Buffer.from(json, "utf-8");
}

/**
 * Deserialize bytes received from the network into a UDPMessage.
 *
 * Unlike TCP, we get the COMPLETE message in one 'message' event.
 * No buffering needed! Each recv() = exactly one datagram.
 */
export function deserialize(data: Buffer): UDPMessage | null {
  try {
    const json = data.toString("utf-8");
    const msg = JSON.parse(json) as UDPMessage;

    // Validate required fields
    if (!msg.type || !msg.id) {
      return null;
    }
    return msg;
  } catch {
    return null;
  }
}

/**
 * Generate a short unique ID for message tracking
 */
export function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Create a response message
 */
export function createResponse(
  requestId: string,
  payload: string,
  type: MessageType = MessageType.RESPONSE,
): UDPMessage {
  return {
    id: generateId(),
    type,
    payload,
    timestamp: Date.now(),
  };
}

/**
 * Protocol constants
 */
export const UDP_PROTOCOL = {
  /**
   * Max safe payload size to avoid IP fragmentation.
   *
   * If a UDP datagram exceeds the network's MTU (typically 1500 bytes),
   * the IP layer FRAGMENTS it into multiple IP packets. If ANY fragment
   * is lost, the ENTIRE datagram is lost (all fragments are discarded).
   *
   * This means larger datagrams have a HIGHER chance of being lost!
   * Keep payloads under this size for reliability.
   */
  MAX_SAFE_PAYLOAD: 1472,

  /** Default server port */
  DEFAULT_PORT: 9001,

  /**
   * Timeout waiting for a response (ms).
   * Unlike TCP, we don't get automatic retransmission.
   * We have to implement our own timeout logic.
   */
  RESPONSE_TIMEOUT: 3000,

  /** Max retries for "reliable" mode */
  MAX_RETRIES: 3,
} as const;
