# 📡 Raw UDP Server & Client — From Scratch

> A **raw UDP server and client** built from scratch using Node.js's built-in `dgram` module. Demonstrates the fundamental differences between UDP and TCP, with simulated packet loss to show why UDP is "unreliable" and when that's actually a feature.

**No frameworks. No magic. Just raw UDP datagrams.**

## 📋 Table of Contents

- [Why This Exists](#-why-this-exists)
- [Quick Start](#-quick-start)
- [TCP vs UDP — The Core Difference](#-tcp-vs-udp--the-core-difference)
- [Architecture](#-architecture)
- [The UDP Protocol — Behind the Scenes](#-the-udp-protocol--behind-the-scenes)
  - [UDP Header](#udp-header-just-8-bytes)
  - [No Connections](#no-connections)
  - [Message Boundaries](#message-boundaries-solved)
  - [Packet Loss](#packet-loss)
- [Our Custom Protocol](#-our-custom-protocol)
- [Key Concepts Demonstrated](#-key-concepts-demonstrated)
- [Project Structure](#-project-structure)
- [Further Reading](#-further-reading)

---

## 🎯 Why This Exists

UDP is deceptively simple — 8-byte header, no connections, fire-and-forget. But this simplicity is **by design**, making it perfect for scenarios where speed matters more than reliability.

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and npm

### Install & Run

```bash
# Install dependencies
npm install

# Terminal 1: Start the UDP server
npx tsx src/server/index.ts

# Terminal 2: Start the client
npx tsx src/client/index.ts
```

### Try the Lossy Mode

```bash
# Start server with 20% simulated packet loss:
LOSS_RATE=0.2 npx tsx src/server/index.ts

# Now commands will randomly "fail" (no response) — just like real UDP!
```

### Available Commands

| Command            | Description                   | Example                                |
| ------------------ | ----------------------------- | -------------------------------------- |
| `PING`             | Measure round-trip time       | `PING` → `PONG (RTT: 2ms)`             |
| `ECHO <msg>`       | Echo back a message           | `ECHO hello` → `hello`                 |
| `TIME`             | Get server time               | `TIME` → timestamp                     |
| `INFO`             | Server & packet stats         | `INFO` → stats                         |
| `LOSSY_ECHO <msg>` | Echo with 50% drop rate       | Sometimes responds, sometimes doesn't! |
| `STATS`            | Client-side packet statistics | Shows sent/received/lost counts        |
| `QUIT`             | Stop the client               | Instant close (no handshake!)          |

---

## ⚔️ TCP vs UDP — The Core Difference

```
                    TCP                              UDP
              ┌────────────────┐              ┌────────────────┐
              │  Phone Call 📞  │              │  Postal Mail 📬 │
              ├────────────────┤              ├────────────────┤
              │ 1. Dial number │              │                │
              │ 2. Wait for    │              │ Just send the  │
              │    answer      │              │ letter!         │
              │ 3. Talk        │              │                │
              │ 4. Say goodbye │              │ No guarantee   │
              │ 5. Hang up     │              │ it arrives.    │
              │                │              │ No confirmation.│
              │ Both sides     │              │ No call needed. │
              │ KNOW who       │              │                │
              │ they're        │              │ Sender doesn't │
              │ talking to.    │              │ even know if   │
              │                │              │ recipient      │
              │ Every word     │              │ exists!        │
              │ is heard.      │              │                │
              └────────────────┘              └────────────────┘
```

| Feature            | TCP (Project #1)            | UDP (This project)               |
| ------------------ | --------------------------- | -------------------------------- |
| Connection         | Required (3-way handshake)  | None needed                      |
| Reliability        | Guaranteed delivery         | Best effort (can lose packets)   |
| Ordering           | Guaranteed in-order         | No ordering guarantee            |
| Data model         | Byte stream (no boundaries) | Datagrams (preserved boundaries) |
| Header size        | 20-60 bytes                 | **8 bytes**                      |
| Speed              | Slower (handshake + ACKs)   | Faster (zero overhead)           |
| Flow control       | Yes (sliding window)        | None                             |
| Congestion control | Yes (slow start, CUBIC)     | None                             |
| Use case           | Web, API, file transfer     | Gaming, video, DNS, VoIP         |

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    APPLICATION LAYER                      │
│                                                          │
│  ┌──────────────┐         ┌──────────────┐              │
│  │  UDP Client   │  fire   │  UDP Server   │              │
│  │  (interactive │  and    │  (single      │              │
│  │   CLI with    │ forget! │   socket for  │              │
│  │   timeout     │ ──────→ │   ALL clients)│              │
│  │   detection)  │         │              │              │
│  │              │ ←─ ─ ─ ─│  (may or may  │              │
│  │              │ maybe?   │   not reply!) │              │
│  └──────┬───────┘         └──────┬───────┘              │
│         │                        │                       │
│         └────────┬───────────────┘                       │
│                  │                                       │
│          ┌───────┴──────┐                                │
│          │  Protocol    │                                │
│          │  (JSON       │                                │
│          │   datagrams) │                                │
│          └──────────────┘                                │
│                                                          │
├──────────────────────────────────────────────────────────┤
│               NODE.JS dgram MODULE                       │
│  Single UDP socket, recvfrom/sendto                     │
├──────────────────────────────────────────────────────────┤
│               OPERATING SYSTEM KERNEL                    │
│  UDP/IP stack, NO connection state, NO retransmission   │
├──────────────────────────────────────────────────────────┤
│                  NETWORK INTERFACE                       │
│  Ethernet frames, Wi-Fi, physical medium                │
└──────────────────────────────────────────────────────────┘
```

---

## 🔍 The UDP Protocol — Behind the Scenes

### UDP Header: Just 8 Bytes

Compare UDP's tiny header to TCP's:

```
UDP Header (8 bytes):
┌──────────────────┬──────────────────┐
│   Source Port     │  Dest Port       │
│   (2 bytes)       │  (2 bytes)       │
├──────────────────┬──────────────────┤
│   Length          │  Checksum        │
│   (2 bytes)       │  (2 bytes)       │
├──────────────────┴──────────────────┤
│           Payload (our data)         │
└─────────────────────────────────────┘

TCP Header (20-60 bytes):
┌──────────────────┬──────────────────┐
│   Source Port     │  Dest Port       │
├──────────────────┴──────────────────┤
│          Sequence Number             │
├─────────────────────────────────────┤
│       Acknowledgment Number          │
├─────────────────────────────────────┤
│ Offset │ Flags  │  Window Size      │
├──────────────────┬──────────────────┤
│   Checksum       │  Urgent Pointer  │
├──────────────────┴──────────────────┤
│       Options (up to 40 bytes)       │
└─────────────────────────────────────┘

See the difference? TCP needs sequence numbers, ACKs, flags,
window sizes, and options. UDP just has: ports + length + checksum.
```

### No Connections

```
TCP Server Setup:            UDP Server Setup:
─────────────────            ─────────────────
1. socket()                  1. socket()
2. bind()                    2. bind()
3. listen()  ← not in UDP
4. accept()  ← not in UDP   Done! Ready to receive!
5. Per-client handling       One socket handles everything

TCP has CONNECTIONS:          UDP has DATAGRAMS:
┌────────┐ conn1 ┌────────┐  ┌────────┐ dgram ┌────────┐
│Client A│──────│Server  │  │Client A│──────►│Server  │
│        │      │socket1 │  │        │       │        │
├────────┤ conn2├────────┤  ├────────┤ dgram │ SAME   │
│Client B│──────│Server  │  │Client B│──────►│ socket │
│        │      │socket2 │  │        │       │ for    │
├────────┤ conn3├────────┤  ├────────┤ dgram │ ALL!   │
│Client C│──────│Server  │  │Client C│──────►│        │
└────────┘      └────────┘  └────────┘       └────────┘
```

### Message Boundaries: Solved

Remember the biggest problem from Project #1 (TCP)?

```
TCP: "PING\nECHO hello\n" might arrive as:
  Event 1: "PI"
  Event 2: "NG\nECH"
  Event 3: "O hello\n"
  → Need a parser to reassemble messages!

UDP: Each send() = exactly one message event:
  send("PING")   →  message event: "PING"      ← complete!
  send("ECHO hi") → message event: "ECHO hi"   ← complete!
  → No parser needed! Each datagram is independent!
```

### Packet Loss

The #1 thing to understand about UDP: **datagrams can be lost silently**.

```
Client sends 5 datagrams:
  [1] PING      ──→  ✅ Received by server
  [2] ECHO hi   ──→  ✅ Received by server
  [3] TIME      ──→  ❌ DROPPED (router buffer overflow)
  [4] INFO      ──→  ✅ Received by server
  [5] PING      ──→  ✅ Received by server

The client sends [3], waits... nothing comes back.
Was it our datagram that was lost? Or the server's response?
We'll NEVER know. This is fundamental to UDP.

In TCP, this would NEVER happen:
  [3] TIME ──→ (lost) ──→ kernel detects missing ACK
                          ──→ kernel retransmits automatically
                          ──→ eventually arrives ✅
```

**Where packets are lost in real networks:**

1. **Sender's NIC buffer overflow** — sending too fast
2. **Router queue overflow** — network congestion (most common!)
3. **Checksum failure** — data corrupted in transit
4. **TTL expiration** — packet routed in circles
5. **Firewall drop** — security rules blocked it
6. **Receiver's socket buffer overflow** — receiver too slow

---

## 📦 Our Custom Protocol

Since UDP preserves message boundaries, we use JSON-encoded datagrams:

```
REQUEST datagram:
{
  "id": "a1b2c3d4",         ← unique ID for tracking
  "type": "REQUEST",
  "command": "ECHO",
  "payload": "hello world",
  "timestamp": 1709952000, ← for measuring RTT
  "seq": 5                 ← for detecting reordering
}

RESPONSE datagram:
{
  "id": "e5f6g7h8",
  "type": "RESPONSE",
  "payload": "hello world",
  "timestamp": 1709952001
}
```

**Why JSON instead of `\n`-delimited text like TCP?**

- We don't NEED delimiters — each datagram is one complete message
- JSON makes it easy to include metadata (id, seq, timestamp)
- In production, you'd use binary encoding (Protobuf) for efficiency

---

## 💡 Key Concepts Demonstrated

### 1. Connectionless Communication

No handshake needed — just send datagrams to an address. The server doesn't know clients exist until it receives their first datagram. [→ src/server/udp-server.ts](src/server/udp-server.ts)

### 2. Packet Loss & Detection

UDP provides no delivery guarantee. We implement timeout-based loss detection on the client side. [→ src/client/udp-client.ts](src/client/udp-client.ts)

### 3. Simulated Network Loss

The server can drop incoming datagrams at a configurable rate, demonstrating real-world packet loss behavior. [→ src/server/udp-server.ts](src/server/udp-server.ts)

### 4. Message Boundaries

Unlike TCP, each `send()` creates exactly one datagram received as one `message` event. No buffering or parsing needed! [→ src/protocol/protocol.ts](src/protocol/protocol.ts)

### 5. Single Socket Architecture

One UDP socket handles ALL clients (vs TCP where each client gets its own socket via `accept()`). [→ src/server/udp-server.ts](src/server/udp-server.ts)

### 6. RTT Measurement

Since UDP has no kernel-level RTT tracking, we measure it ourselves using timestamps in our protocol. [→ src/client/udp-client.ts](src/client/udp-client.ts)

---

## 📁 Project Structure

```
raw-udp-server/
├── README.md              ← You are here
├── package.json
├── tsconfig.json
├── Makefile
├── src/
│   ├── server/
│   │   ├── index.ts       ← Server entry point (with LOSS_RATE env var)
│   │   └── udp-server.ts  ← UDP server (single socket, all clients)
│   ├── client/
│   │   ├── index.ts       ← Client entry point
│   │   └── udp-client.ts  ← Interactive client with timeout detection
│   └── protocol/
│       └── protocol.ts    ← Protocol definition (JSON datagrams)
└── docs/
    ├── udp-vs-tcp.md      ← Deep dive: comparing the two protocols
    └── packet-loss.md     ← Deep dive: understanding packet loss
```

---

## 🔧 Configuration

| Environment Variable | Default   | Description                                |
| -------------------- | --------- | ------------------------------------------ |
| `PORT`               | `9001`    | Server listening port                      |
| `HOST`               | `0.0.0.0` | Server bind address                        |
| `LOSS_RATE`          | `0`       | Simulated loss rate (0-1, e.g., 0.2 = 20%) |

```bash
# Run with 30% packet loss simulation
LOSS_RATE=0.3 npx tsx src/server/index.ts
```

---

## 🧪 Experiments to Try

### 1. Compare TCP vs UDP Latency

```bash
# In Project 1 (TCP): Notice the connection setup time
time echo -e "PING\nQUIT" | nc localhost 9000

# In this project (UDP): No connection setup!
time echo '{"id":"t","type":"REQUEST","command":"PING","payload":"","timestamp":0}' | nc -u -w 1 localhost 9001
```

### 2. Observe Packet Loss

```bash
# Start server with 50% loss:
LOSS_RATE=0.5 npx tsx src/server/index.ts

# Send many PINGs and watch the client's STATS:
# Some will timeout, some will succeed!
```

### 3. Watch with tcpdump

```bash
# Capture UDP packets:
sudo tcpdump -i lo0 udp port 9001 -vv

# Notice: No SYN, no ACK, no FIN — just data packets!
```

---

## 📚 Further Reading

- [RFC 768](https://tools.ietf.org/html/rfc768) — User Datagram Protocol (fit in 3 pages!)
- [RFC 8085](https://tools.ietf.org/html/rfc8085) — UDP Usage Guidelines
- [When to use UDP vs TCP](https://gafferongames.com/post/udp_vs_tcp/) — Game networking perspective

---

## 📄 License

MIT — Build, learn, and share! 🚀
