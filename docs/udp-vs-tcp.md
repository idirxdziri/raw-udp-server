# ⚔️ Deep Dive: UDP vs TCP

## At the System Call Level

### TCP Server Lifecycle

```
socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) → fd
bind(fd, {addr: "0.0.0.0", port: 9000})
listen(fd, backlog=128)
                                            ← Client sends SYN
                                            → Kernel replies SYN-ACK
                                            ← Client sends ACK
                                            → Connection in accept queue
client_fd = accept(fd, &client_addr)        ← New fd PER client
recv(client_fd, buffer, len, flags)         ← Reliable byte stream
send(client_fd, buffer, len, flags)         → Reliable byte stream
close(client_fd)                            → FIN/ACK teardown
close(fd)                                   → Listening socket closed
```

### UDP Server Lifecycle

```
socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP) → fd
bind(fd, {addr: "0.0.0.0", port: 9001})
                                            ← Datagram arrives
recvfrom(fd, buffer, len, flags, &src_addr) ← ONE complete datagram
sendto(fd, buffer, len, flags, dst_addr)    → ONE complete datagram
close(fd)                                   → Socket closed (instant)
```

**Notice:**

- No `listen()` — nothing to "listen" for (no connections)
- No `accept()` — no connections to accept
- Same `fd` for ALL clients — `recvfrom()` tells us who sent it
- `close()` is instant — no teardown handshake

## Memory & Resources

### TCP

```
Per connection:
  • Kernel: ~3-10KB (socket buffer, TCP control block)
  • Node.js: Socket object, event handlers, buffers
  • 10,000 connections = 30-100MB of kernel memory

The C10K problem: Handling 10,000 simultaneous TCP connections
was a major engineering challenge in the early 2000s.
```

### UDP

```
Per "client":
  • Kernel: 0 bytes (no per-client state!)
  • Node.js: Whatever we choose to track
  • 10,000 clients = Just our application tracking data

UDP doesn't have the C10K problem at the OS level.
But you also don't get reliability, so you're on your own.
```

## When to Use Each

### Use TCP When

| Scenario            | Why TCP?                          |
| ------------------- | --------------------------------- |
| Web browsing (HTTP) | Need complete, ordered HTML       |
| File transfer       | Every byte must arrive            |
| API calls           | Request/response must be reliable |
| Database queries    | Data integrity is critical        |
| Email (SMTP)        | Messages can't be lost            |
| SSH                 | Every keystroke must arrive       |

### Use UDP When

| Scenario         | Why UDP?                                  |
| ---------------- | ----------------------------------------- |
| DNS queries      | Single request/response, speed matters    |
| Live video/audio | Late frames are useless, skip them        |
| Online gaming    | Stale position data is worse than no data |
| IoT sensors      | Periodic data, losing one reading is fine |
| VoIP             | Real-time audio can't wait for retransmit |
| NTP (time sync)  | Single datagram, needs low latency        |

### The Spectrum

```
← Pure reliability                          Pure speed →
├──────────┬────────────┬──────────┬──────────────────┤
│   TCP    │  TCP fast  │  QUIC    │     UDP          │
│          │  open      │ (HTTP/3) │                  │
│ 3-way    │ 1-RTT     │ 0-RTT   │ 0-RTT            │
│ handshake│ resume    │ + reliable│ + unreliable     │
│ reliable │ reliable  │ + ordered │ + unordered      │
│ ordered  │ ordered   │ + encrypted│+ plaintext      │
└──────────┴────────────┴──────────┴──────────────────┘
```

## Head-of-Line (HOL) Blocking

One of TCP's biggest problems:

```
TCP: Packets arrive at the receiver:
  [1] ✅  [2] ✅  [3] ❌ lost  [4] ✅  [5] ✅

  The kernel has [1], [2], [4], [5] but is WAITING for [3].
  It cannot deliver [4] and [5] to the application until [3]
  is retransmitted and received!

  Application sees: [1] [2] ......waiting...... [3] [4] [5]

  [4] and [5] are STUCK behind [3]. This is HOL blocking.
  It's terrible for multiplexed protocols (HTTP/2 over TCP).

UDP: Same scenario:
  [1] ✅  [2] ✅  [3] ❌ lost  [4] ✅  [5] ✅

  Application sees: [1] [2] [4] [5]

  [3] is simply gone. [4] and [5] are delivered immediately.
  No blocking! Application can decide what to do about [3].
```

This is why **HTTP/3 uses QUIC (built on UDP)** instead of TCP!
