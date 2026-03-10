# 📦 Deep Dive: Packet Loss in UDP

## Why Packets Are Lost

UDP provides **no delivery guarantee**. Packets (datagrams) can be lost at multiple points in the network path.

### The Journey of a UDP Datagram

```
YOUR APP                                                 SERVER APP
   │                                                        │
   ▼ socket.send()                                          │
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Send    │    │  Router  │    │  Router  │    │  Recv    │
│  Buffer  │───→│    A     │───→│    B     │───→│  Buffer  │
│ (kernel) │    │          │    │          │    │ (kernel) │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
 Drop point 1   Drop point 2    Drop point 3    Drop point 4
                                                     │
                                                     ▼ socket.on('message')
                                                  SERVER APP
```

### Drop Point 1: Sender's Kernel Buffer Full

```
Your app sends datagrams faster than the NIC can transmit them.
The kernel's UDP send buffer is full.
   → send() returns EAGAIN/EWOULDBLOCK error
   → Datagram is NOT sent
   → Application can detect this (but usually doesn't!)

This is like trying to stuff too many letters into a mailbox.
```

### Drop Point 2 & 3: Router Queue Overflow (Most Common!)

```
Router has a finite output queue. During congestion:

┌────────────────────────────┐
│ Router Input Queue          │
│ [pkt] [pkt] [pkt] [pkt]   │
│                            │
│ Router Output Queue (FULL!)│
│ [pkt] [pkt] [pkt] [pkt]   │ → NIC sending
│ [NEW PKT] → ❌ DROPPED!   │
└────────────────────────────┘

The router silently drops the packet. No error is sent back.
Neither sender nor receiver knows this happened.

This is called "tail drop" — the most common cause of packet loss.

Modern routers use "Active Queue Management" (AQM):
  - RED (Random Early Detection): Drop packets BEFORE queue is full
  - CoDel: Drop based on queue delay, not queue length
  - ECN: Mark packets instead of dropping (works with TCP, not raw UDP)
```

### Drop Point 3.5: Checksum Failure

```
A bit gets flipped during transmission (cosmic ray, electrical noise):

Sent:     10110100 01001001 ...
Received: 10110100 01001001 ...
                        ↑ bit flip!

The receiver computes the checksum and it doesn't match.
   → Datagram is SILENTLY DISCARDED
   → No notification to sender
   → Application never knows

In IPv4, UDP checksum is optional (0 = no checksum).
In IPv6, it's mandatory.
```

### Drop Point 4: Receiver's Kernel Buffer Full

```
Server app is too slow to read datagrams from the kernel buffer.
New datagrams arrive but the buffer is full.
   → Kernel drops the newest datagram
   → Application never sees it

┌─────────────────────────────┐
│ Receiver Socket Buffer       │
│ [pkt][pkt][pkt][pkt] FULL!  │
│ [NEW] → ❌ DROPPED           │
└─────────────────────────────┘

Fix: Increase buffer size (our server sets 1MB):
  socket.setRecvBufferSize(1024 * 1024);

But there's a limit — the OS caps this (sysctl net.core.rmem_max).
```

## The Ambiguity Problem

The hardest part about UDP packet loss: **you can't tell WHAT was lost**.

```
Client sends REQUEST, waits for RESPONSE...

Scenario 1: REQUEST was lost
  Client ─── [REQUEST] ──→ ❌                    Server
  Client sees: timeout (no response)

Scenario 2: Server crashed
  Client ─── [REQUEST] ──→ Server 💥
  Client sees: timeout (no response)

Scenario 3: RESPONSE was lost
  Client ─── [REQUEST] ──→ Server (processes it!)
  Client ← ❌ ─── [RESPONSE] ── Server
  Client sees: timeout (no response)

All three look IDENTICAL to the client!
It just sees "no response within timeout period."
```

## Strategies to Handle Loss

### 1. Accept It (Best for Real-Time)

```
Use case: Video streaming, gaming
Strategy: Don't retry stale data
Example:
  Frame 1: ✅ render
  Frame 2: ❌ lost
  Frame 3: ✅ render ← Frame 2 is already outdated, skip it!
```

### 2. Application-Level ACKs

```
Use case: DNS, custom reliable protocols
Strategy: Wait for ACK, retry on timeout

  Client → [REQUEST id=1] → Server
  Client ← [ACK id=1]     ← Server

  If no ACK within timeout:
  Client → [REQUEST id=1] → Server (retry!)
  Client ← [ACK id=1]     ← Server
```

### 3. Forward Error Correction (FEC)

```
Use case: Video/audio streaming
Strategy: Send redundant data so receiver can reconstruct lost packets

  Send: [pkt1] [pkt2] [pkt3] [FEC(1,2,3)]
  Recv: [pkt1] [pkt2] [---]  [FEC(1,2,3)]

  Can reconstruct pkt3 from FEC data!
  No retransmission needed (lower latency).
```

### 4. Build Reliability on Top of UDP

```
This is exactly what QUIC (HTTP/3) does!
  → UDP datagrams as transport
  → Application-level ACKs and retransmission
  → Application-level congestion control
  → Per-stream ordering (no HOL blocking!)
  → Built-in encryption (TLS 1.3)
```

## Measuring Packet Loss

```bash
# Monitor UDP socket statistics:
netstat -su

# Watch for buffer overflow drops:
cat /proc/net/udp   # Linux

# Capture and count packets:
sudo tcpdump -i lo0 udp port 9001 -c 100 | wc -l
```
