# ⚖️ Node.js HTTP Round-Robin Load Balancer

A high-performance, zero-dependency HTTP reverse proxy and load balancer written in Node.js (version 18+) using only native built-in modules (`http`, `url`, `stream`, `events`, `child_process`).

Features include:
- **Smooth Weighted Round-Robin (SWRR)** scheduling algorithm (Nginx-style).
- **Active Health Probing**: Periodic `/health` heartbeat checks with state transition logging (`DOWN` / `RECOVERED`).
- **Zero-Drop Failover Retries**: Complete request body buffering to replay requests across alternative backends on connection failure or 5-second timeout.
- **Header Enrichment**: Injects `X-Served-By` indicating the backend handler, alongside standard `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host`.
- **Live Statistics**: Built-in `GET /stats` API exposing backend health, request counts, and failure rates.
- **Graceful Shutdown**: Drains open connections and cleans up timers on `SIGINT` / `SIGTERM`.

---

## 🏛️ System Architecture

```
                                  +-----------------------------+
                                  |         HTTP Clients        |
                                  | (cURL, Browsers, Autocannon)|
                                  +--------------+--------------+
                                                 |
                                                 v :8000
                              +---------------------------------+
                              |      balancer.js (:8000)        |
                              |  - Smooth Weighted Round-Robin  |
                              |  - Active Health Check (/health)|
                              |  - Request Body Buffering       |
                              |  - Automatic Retry & Failover   |
                              |  - Statistics Endpoint (/stats) |
                              +------------------+--------------+
                                                 |
                   +-----------------------------+-----------------------------+
                   |                             |                             |
                   v :5001                       v :5002                       v :5003
        +---------------------+       +---------------------+       +---------------------+
        |     backend.js      |       |     backend.js      |       |     backend.js      |
        |  Port 5001 (Weight 1)       |  Port 5002 (Weight 1)       |  Port 5003 (Weight 1)
        |  - 100ms Work Lag   |       |  - 100ms Work Lag   |       |  - 100ms Work Lag   |
        |  - GET /health (OK) |       |  - GET /health (OK) |       |  - GET /health (OK) |
        +---------------------+       +---------------------+       +---------------------+
```

---

## 📁 Project Structure

```
load-balancer-node/
├── backend.js        # Test backend HTTP server (supports single port or cluster mode)
├── balancer.js       # The HTTP reverse proxy and load balancer
├── test-client.js    # Distribution verification client with table output
├── package.json      # NPM scripts and project metadata (zero dependencies)
└── README.md         # Architecture, setup guide, load tests, and community wisdom
```

---

## 🚀 Setup and Run Instructions (5 Terminals)

To see the load balancer in action with live logs, open 5 separate terminal windows in the project directory:

### Terminal 1: Backend Instance 1
```bash
node backend.js 5001
```
*Listens on `http://127.0.0.1:5001` with a 100ms delay on work endpoints and instant 200 on `/health`.*

### Terminal 2: Backend Instance 2
```bash
node backend.js 5002
```
*Listens on `http://127.0.0.1:5002`.*

### Terminal 3: Backend Instance 3
```bash
node backend.js 5003
```
*Listens on `http://127.0.0.1:5003`.*

### Terminal 4: Load Balancer
```bash
npm run start:balancer
# or: node balancer.js
```
*Listens on `http://127.0.0.1:8000`. Starts health checks every 5 seconds and routes requests across the 3 backends.*

### Terminal 5: Test Client / Verification
Run the 30-request distribution test:
```bash
npm test
# or: node test-client.js 30
```

#### Expected Test Output:
```
=======================================================
🧪 Load Balancer Distribution Test
   Target:       http://127.0.0.1:8000
   Total Reqs:   30 sequential
=======================================================

Detected 3 backends configured in load balancer:
  - 127.0.0.1:5001 [Weight: 1, Healthy: true]
  - 127.0.0.1:5002 [Weight: 1, Healthy: true]
  - 127.0.0.1:5003 [Weight: 1, Healthy: true]

[Req 01/30] 200 OK <- 127.0.0.1:5001   (110ms)
[Req 02/30] 200 OK <- 127.0.0.1:5002   (109ms)
[Req 03/30] 200 OK <- 127.0.0.1:5003   (108ms)
...
[Req 30/30] 200 OK <- 127.0.0.1:5003   (108ms)

=======================================================
📊 DISTRIBUTION RESULTS
=======================================================
┌─────────┬──────────────────┬──────┬─────────┬─────────────────┬──────────┐
│ (index) │ Backend          │ Hits │ Share   │ Expected (Even) │ Even?    │
├─────────┼──────────────────┼──────┼─────────┼─────────────────┼──────────┤
│ 0       │ '127.0.0.1:5001' │ 10   │ '33.3%' │ '10'            │ '✅ YES' │
│ 1       │ '127.0.0.1:5002' │ 10   │ '33.3%' │ '10'            │ '✅ YES' │
│ 2       │ '127.0.0.1:5003' │ 10   │ '33.3%' │ '10'            │ '✅ YES' │
└─────────┴──────────────────┴──────┴─────────┴─────────────────┴──────────┘

🎉 SUCCESS: All 30 requests were distributed perfectly evenly!
```

---

## 🔍 Testing Failure Handling & Auto-Recovery

### Step 1: Kill a Backend
1. Go to **Terminal 2** (running backend 5002) and press `Ctrl+C` to terminate it.
2. In **Terminal 4** (the balancer), within 5 seconds you will observe the active health check notice the drop:
   ```
   [HEALTH CHECK] Backend 127.0.0.1:5002 is DOWN -> Marked UNHEALTHY (ECONNREFUSED)
   ```

### Step 2: Observe Automatic Failover & Retry
1. Send an HTTP request via `curl` or run the test client:
   ```bash
   curl -i http://127.0.0.1:8000/hello
   ```
2. The balancer routes requests **only** to healthy backends (`5001` and `5003`).
3. If a request was in flight when a backend suddenly crashes, the load balancer's retry mechanism captures the socket error, replays the buffered request payload to the next backend, and the client still gets a `200 OK` response without error.

### Step 3: Inspect Metrics
Query the balancer statistics endpoint:
```bash
curl http://127.0.0.1:8000/stats
```
Response:
```json
{
  "uptimeSeconds": 145,
  "totalRequestsReceived": 31,
  "algorithm": "smooth-weighted-round-robin",
  "backends": [
    { "host": "127.0.0.1", "port": 5001, "weight": 1, "healthy": true, "hits": 16, "failures": 0 },
    { "host": "127.0.0.1", "port": 5002, "weight": 1, "healthy": false, "hits": 10, "failures": 0 },
    { "host": "127.0.0.1", "port": 5003, "weight": 1, "healthy": true, "hits": 15, "failures": 0 }
  ]
}
```

### Step 4: Restart the Backend & Watch Recovery
1. In **Terminal 2**, start the server again:
   ```bash
   node backend.js 5002
   ```
2. In **Terminal 4**, the balancer will automatically detect the recovery on the next probe:
   ```
   [HEALTH CHECK] Backend 127.0.0.1:5002 is UP -> Marked HEALTHY (recovered)
   ```
3. Run `npm test` again — all 3 backends are back in the active rotation, receiving equal shares of traffic.

---

## ⚡ Load Testing with Autocannon

To demonstrate performance scaling, install or run [autocannon](https://github.com/mcollina/autocannon) via `npx`.

### 1. Benchmark a Single Backend Directly
```bash
npx autocannon -c 50 -d 10 http://127.0.0.1:5001/
```
- Because each request incurs a simulated **100ms work delay**, 1 single-threaded backend server can sustain approximately:
  $$\frac{50 \text{ concurrent connections}}{0.10\text{s latency}} \approx 450 - 500 \text{ req/sec}$$

### 2. Benchmark the Balanced Cluster (3 Backends)
```bash
npx autocannon -c 50 -d 10 http://127.0.0.1:8000/
```
- The load balancer spreads the concurrent connections across all three backend processes:
  $$3 \times 450 \approx 1350 - 1500 \text{ req/sec}$$
- **Result:** You will observe a roughly **3x throughput improvement** over a single backend, as workloads are executed concurrently across distinct Node.js process event loops.

---

## ⚠️ Limitations & Production Considerations

While this implementation fulfills core load balancing requirements with zero external dependencies, production enterprise systems address the following trade-offs:

1. **Single Point of Failure (SPOF):**
   - The balancer runs as a single Node.js process on port 8000. If this process crashes or the host goes down, all backends become inaccessible. In production, load balancers run in redundant pairs with Virtual IP failover (e.g., Keepalived / VRRP) or cloud-managed ALBs.
2. **Ignores Dynamic Server Load:**
   - Round-robin and weighted round-robin distribute requests deterministically based on static weights. If one request takes 5 seconds (heavy report generation) and another takes 10ms, round-robin will continue sending new traffic to the busy backend. A **Least-Connections** or **Response-Time Weighted** algorithm is more adaptive for uneven workloads.
3. **Lack of Session Persistence (Sticky Sessions):**
   - If an upstream backend stores user state in memory (e.g., session cookies, auth tokens, shopping carts), subsequent requests may hit a different backend, causing session loss. Sticky sessions (via hash of client IP or cookie-based routing) or external session stores (Redis) are needed for stateful backends.

---

## 🌐 Community Wisdom

When engineering reverse proxies and load balancers, the wider developer community highlights crucial architectural considerations:

1. **Load Balancing Algorithms**:
   - In [*Load Balancing Algorithms (Round Robin, Least Conn)*](https://dev.to/godofgeeks/load-balancing-algorithms-round-robin-least-conn-2id2), author [godofgeeks](https://dev.to/godofgeeks) emphasizes that while Round Robin is the simplest and fairest algorithm for homogeneous microservices, it struggles when request execution times vary widely. Moving towards Least Connections prevents head-of-line queueing under heterogeneous workloads.
   - [Read Full Discussion](https://dev.to/godofgeeks/load-balancing-algorithms-round-robin-least-conn-2id2)

2. **The Reverse Proxy / Gateway Layer**:
   - In [*The Gateway Layer Explained: Reverse Proxies, Load Balancers, and API Gateways — Once and For All*](https://dev.to/walosha/the-gateway-layer-explained-reverse-proxies-load-balancers-and-api-gateways-once-and-for-all-1h41), author [walosha](https://dev.to/walosha) details why request body buffering is critical when building retry layers in Layer 7 proxies. Once HTTP streams are drained, downstreams cannot replay payloads unless the proxy explicitly caches the incoming payload buffer prior to dispatch.
   - [Read Full Discussion](https://dev.to/walosha/the-gateway-layer-explained-reverse-proxies-load-balancers-and-api-gateways-once-and-for-all-1h41)

3. **Stateful Connection Caveats**:
   - In [*Why Round-Robin Load Balancing Breaks WebSockets at Scale*](https://dev.to/nainikmehta/why-round-robin-load-balancing-breaks-websockets-at-scale-2g71), author [nainikmehta](https://dev.to/nainikmehta) highlights that naive round-robin falls short when long-lived connections (WebSockets, SSE) are introduced, requiring hash-based affinity or distributed pub/sub brokers.
   - [Read Full Discussion](https://dev.to/nainikmehta/why-round-robin-load-balancing-breaks-websockets-at-scale-2g71)

---

## 📜 License
MIT License. Built for modern Node.js environments (v18+).
