/**
 * balancer.js - HTTP Round-Robin & Weighted Round-Robin Load Balancer
 *
 * Requirements:
 * 1. Listens on port 8000
 * 2. Round-robin & Smooth Weighted Round-Robin distribution across backends (5001, 5002, 5003)
 * 3. Forwards method, path, headers, and buffered body (GET, POST, PUT, DELETE, etc.)
 * 4. Buffers the request body so it can be resent cleanly on retry
 * 5. Adds "X-Served-By" response header with the backend that answered (e.g. 127.0.0.1:5001)
 * 6. Retry: if a backend fails or times out (5s), try the next backend, up to one attempt per backend, then 503
 * 7. Active Health checks: ping /health every 5s, mark unhealthy on failure, mark healthy on recovery (log both)
 * 8. GET /stats returns JSON with per-backend port, healthy status, total hits, and failures
 * 9. Log every request with timestamp, method, path, and chosen backend
 * 10. Graceful shutdown on SIGINT and SIGTERM
 */

const http = require('http');

// ==========================================
// 1. CONFIGURATION
// ==========================================
const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 8000,
  host: process.env.HOST || '127.0.0.1',
  backendTimeoutMs: 5000,           // 5 seconds timeout before triggering a retry
  healthCheckIntervalMs: 5000,      // Health check every 5 seconds
  healthCheckTimeoutMs: 2000,       // 2 seconds timeout for health check probe
  healthCheckPath: '/health',
  backends: [
    { host: '127.0.0.1', port: 5001, weight: 1 },
    { host: '127.0.0.1', port: 5002, weight: 1 },
    { host: '127.0.0.1', port: 5003, weight: 1 },
  ],
};

// ==========================================
// 2. STATE INITIALIZATION
// ==========================================
// Enrich backend configuration with runtime state for metrics and algorithm
const backends = CONFIG.backends.map(b => ({
  ...b,
  id: `${b.host}:${b.port}`,
  healthy: true,           // Start optimistic, updated by health checks
  hits: 0,                 // Number of successfully handled requests
  failures: 0,             // Number of failed requests/timeouts
  currentWeight: 0,        // Dynamic accumulator for Smooth Weighted Round-Robin
}));

let totalRequestsReceived = 0;
const serverStartTime = Date.now();

// ==========================================
// 3. SMOOTH WEIGHTED ROUND-ROBIN ALGORITHM
// ==========================================
/**
 * Selects the next available healthy backend using Nginx's Smooth Weighted Round-Robin (SWRR).
 * When all weights are equal (e.g. 1, 1, 1), this produces exact classic Round-Robin interleaving.
 * If some backends have higher weights, traffic is distributed proportionally without burstiness.
 *
 * @param {Set<string>} attemptedIds - Set of backend IDs already tried for the current request
 * @returns {object|null} Selected backend object, or null if no healthy candidate remains
 */
function getNextBackend(attemptedIds = new Set()) {
  // Filter for backends that are currently healthy and have not been tried yet for this request
  const candidates = backends.filter(b => b.healthy && !attemptedIds.has(b.id));

  if (candidates.length === 0) {
    // If all healthy backends were tried, check if there are any remaining backends at all
    // (fallback for edge cases where all are marked unhealthy but we can try once)
    const untried = backends.filter(b => !attemptedIds.has(b.id));
    if (untried.length === 0) return null;
    // As a last-resort fallback, pick one of the untried backends
    return untried[0];
  }

  let totalWeight = 0;
  let selected = null;

  for (const backend of candidates) {
    backend.currentWeight += backend.weight;
    totalWeight += backend.weight;

    if (!selected || backend.currentWeight > selected.currentWeight) {
      selected = backend;
    }
  }

  if (selected) {
    selected.currentWeight -= totalWeight;
  }

  return selected;
}

// ==========================================
// 4. REQUEST BODY BUFFERING HELPER
// ==========================================
/**
 * Reads and buffers the entire incoming HTTP request body into memory.
 * This is critical for retry capability: Node's IncomingMessage stream can only be read once.
 * Buffering allows the exact payload to be retransmitted to another backend if the first fails.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function bufferRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', err => reject(err));
  });
}

// ==========================================
// 5. REVERSE PROXY & RETRY LOGIC
// ==========================================
/**
 * Dispatches an HTTP request to a backend with automatic retry on failure or timeout.
 * Up to one attempt per backend is allowed before returning 503 Service Unavailable.
 *
 * @param {http.IncomingMessage} req - Client request
 * @param {http.ServerResponse} res - Client response
 * @param {Buffer} bodyBuffer - Buffered request body
 * @param {Set<string>} attemptedIds - Track tried backends to avoid infinite loops
 * @param {number} attemptNumber - 1-based attempt counter
 */
function dispatchWithRetry(req, res, bodyBuffer, attemptedIds = new Set(), attemptNumber = 1) {
  const backend = getNextBackend(attemptedIds);

  // If no backend is available or all backends have been exhausted
  if (!backend) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] 503 Service Unavailable for ${req.method} ${req.url} - All backends exhausted (${attemptedIds.size} tried)`);

    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Service Unavailable',
        message: 'No healthy backends available to fulfill the request',
        attemptedBackends: Array.from(attemptedIds),
      }));
    }
    return;
  }

  attemptedIds.add(backend.id);

  const timestamp = new Date().toISOString();
  if (attemptNumber === 1) {
    console.log(`[${timestamp}] ${req.method} ${req.url} -> ${backend.id} (Attempt ${attemptNumber})`);
  } else {
    console.warn(`[${timestamp}] Retrying ${req.method} ${req.url} -> ${backend.id} (Attempt ${attemptNumber})`);
  }

  // Clone headers and rewrite Host & X-Forwarded headers
  const proxyHeaders = { ...req.headers };
  proxyHeaders['host'] = `${backend.host}:${backend.port}`;

  const clientIp = req.socket.remoteAddress || '';
  if (proxyHeaders['x-forwarded-for']) {
    proxyHeaders['x-forwarded-for'] = `${proxyHeaders['x-forwarded-for']}, ${clientIp}`;
  } else if (clientIp) {
    proxyHeaders['x-forwarded-for'] = clientIp;
  }
  proxyHeaders['x-forwarded-proto'] = 'http';
  proxyHeaders['x-forwarded-host'] = req.headers['host'] || `${CONFIG.host}:${CONFIG.port}`;

  // Ensure content-length is exact if we have a body buffer
  if (bodyBuffer.length > 0) {
    proxyHeaders['content-length'] = bodyBuffer.length;
    delete proxyHeaders['transfer-encoding'];
  }

  const requestOptions = {
    hostname: backend.host,
    port: backend.port,
    path: req.url,
    method: req.method,
    headers: proxyHeaders,
    timeout: CONFIG.backendTimeoutMs,
  };

  let hasResponded = false;

  const proxyReq = http.request(requestOptions, (proxyRes) => {
    hasResponded = true;
    backend.hits++;

    // Add required "X-Served-By" response header
    const responseHeaders = { ...proxyRes.headers };
    responseHeaders['x-served-by'] = `${backend.host}:${backend.port}`;

    res.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(res);
  });

  // Handle timeout (5 seconds default)
  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error(`Connection to ${backend.id} timed out after ${CONFIG.backendTimeoutMs}ms`));
  });

  // Handle socket / network errors
  proxyReq.on('error', (err) => {
    backend.failures++;
    const errTimestamp = new Date().toISOString();
    console.error(`[${errTimestamp}] Error proxying to ${backend.id}: ${err.message}`);

    // If headers haven't been sent back to the client yet, retry with the next backend!
    if (!res.headersSent && !hasResponded) {
      dispatchWithRetry(req, res, bodyBuffer, attemptedIds, attemptNumber + 1);
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  // Write the buffered body to backend request
  if (bodyBuffer.length > 0) {
    proxyReq.write(bodyBuffer);
  }
  proxyReq.end();
}

// ==========================================
// 6. HEALTH CHECK MONITORING
// ==========================================
/**
 * Performs periodic HTTP GET health check probes to /health on all registered backends.
 * Detects failures and recoveries, updates health state, and logs transitions.
 */
function probeBackendHealth(backend) {
  const options = {
    hostname: backend.host,
    port: backend.port,
    path: CONFIG.healthCheckPath,
    method: 'GET',
    timeout: CONFIG.healthCheckTimeoutMs,
  };

  const req = http.request(options, (res) => {
    // Consume response stream to free socket
    res.resume();

    const isHealthyNow = res.statusCode === 200;
    updateBackendHealthState(backend, isHealthyNow, `HTTP status ${res.statusCode}`);
  });

  req.on('timeout', () => {
    req.destroy();
    updateBackendHealthState(backend, false, `Timed out after ${CONFIG.healthCheckTimeoutMs}ms`);
  });

  req.on('error', (err) => {
    updateBackendHealthState(backend, false, err.code || err.message);
  });

  req.end();
}

/**
 * Updates backend health status and logs transitions between healthy/unhealthy.
 */
function updateBackendHealthState(backend, isHealthy, reason) {
  const timestamp = new Date().toISOString();

  if (backend.healthy && !isHealthy) {
    // Transition: Healthy -> Unhealthy
    backend.healthy = false;
    // Reset weights so rotation restarts clean among remaining backends
    backends.forEach(b => { b.currentWeight = 0; });
    console.warn(`[${timestamp}] [HEALTH CHECK] Backend ${backend.id} is DOWN -> Marked UNHEALTHY (${reason})`);
  } else if (!backend.healthy && isHealthy) {
    // Transition: Unhealthy -> Healthy (Recovery)
    backend.healthy = true;
    // Reset weights so newly recovered backend enters rotation cleanly
    backends.forEach(b => { b.currentWeight = 0; });
    console.log(`[${timestamp}] [HEALTH CHECK] Backend ${backend.id} is UP -> Marked HEALTHY (recovered)`);
  }
}

/**
 * Runs health check across all backends.
 */
function runAllHealthChecks() {
  backends.forEach(backend => probeBackendHealth(backend));
}

// ==========================================
// 7. HTTP LOAD BALANCER SERVER
// ==========================================
const server = http.createServer(async (req, res) => {
  totalRequestsReceived++;

  // Expose GET /stats returning JSON per-backend port, healthy status, hits, and failures
  if (req.method === 'GET' && req.url === '/stats') {
    const statsData = {
      uptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000),
      totalRequestsReceived,
      algorithm: 'smooth-weighted-round-robin',
      backends: backends.map(b => ({
        host: b.host,
        port: b.port,
        weight: b.weight,
        healthy: b.healthy,
        hits: b.hits,
        failures: b.failures,
      })),
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(statsData, null, 2));
    return;
  }

  // Handle incoming application request
  try {
    // Buffer body so it can be retransmitted upon backend retry
    const bodyBuffer = await bufferRequestBody(req);
    dispatchWithRetry(req, res, bodyBuffer);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to buffer request:`, err.message);
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Request', message: err.message }));
    }
  }
});

// Start listening
server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`=======================================================`);
  console.log(`🚀 HTTP Load Balancer running at http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`=======================================================`);
  console.log(`Backends configured:`);
  backends.forEach(b => {
    console.log(`  - ${b.id} (Weight: ${b.weight}, Healthy: ${b.healthy})`);
  });
  console.log(`Endpoints:`);
  console.log(`  - Stats & Health metrics: GET http://${CONFIG.host}:${CONFIG.port}/stats`);
  console.log(`  - Application Traffic:    Any request forwarded to backends`);
  console.log(`Health check interval: ${CONFIG.healthCheckIntervalMs / 1000}s`);
  console.log(`Backend timeout:       ${CONFIG.backendTimeoutMs / 1000}s`);
  console.log(`=======================================================\n`);

  // Run initial health checks immediately, then repeat on schedule
  runAllHealthChecks();
});

// Periodic health check timer
const healthCheckInterval = setInterval(runAllHealthChecks, CONFIG.healthCheckIntervalMs);
// Unref timer so it doesn't hold open process during shutdown
healthCheckInterval.unref();

// ==========================================
// 8. GRACEFUL SHUTDOWN
// ==========================================
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Load Balancer] Received ${signal}. Starting graceful shutdown...`);
  clearInterval(healthCheckInterval);

  server.close(() => {
    console.log('[Load Balancer] Server closed. All pending connections finished.');
    process.exit(0);
  });

  // Force close if connections don't drain within 5 seconds
  setTimeout(() => {
    console.warn('[Load Balancer] Forcefully terminating open connections.');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
