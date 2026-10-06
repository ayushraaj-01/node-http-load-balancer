/**
 * backend.js - Simulated Backend HTTP Server
 *
 * Requirements:
 * 1. Takes the port from command line: node backend.js <PORT>
 * 2. Responds "Hello from backend on port <PORT>" after a 100 ms delay
 * 3. Exposes GET /health returning 200 with no delay
 * 4. Supports multi-backend launch if run with "all" or without arguments:
 *    node backend.js all -> starts 5001, 5002, 5003
 */

const http = require('http');
const { spawn } = require('child_process');

// Determine execution mode: single server on given port, or launcher for all backends
const arg = process.argv[2];

if (arg === 'all' || (!arg && process.env.NODE_ENV !== 'production')) {
  // If run with 'all' or without args from terminal, launch the 3 test backends
  const ports = [5001, 5002, 5003];
  console.log(`[Backends Manager] Launching ${ports.length} backend instances on ports: ${ports.join(', ')}...`);

  const children = ports.map(p => {
    const child = spawn(process.execPath, [__filename, String(p)], {
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      console.log(`[Backends Manager] Backend on port ${p} exited with code ${code}`);
    });
    return child;
  });

  const cleanup = () => {
    console.log('\n[Backends Manager] Terminating all backend processes...');
    children.forEach(c => c.kill('SIGINT'));
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
} else {
  // Single backend mode
  const port = parseInt(arg, 10);
  if (isNaN(port)) {
    console.error(`Error: Invalid port specified "${arg}". Usage: node backend.js <PORT>`);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    const start = Date.now();

    // 1. Health check endpoint: GET /health returns 200 immediately with NO delay
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Backend-Port': String(port),
      });
      res.end(JSON.stringify({ status: 'ok', port, timestamp: new Date().toISOString() }));
      return;
    }

    // 2. Consume request body if present (for POST/PUT/DELETE/etc.)
    req.on('data', () => {});
    req.on('end', () => {
      // Simulate 100 ms workload delay
      setTimeout(() => {
        const duration = Date.now() - start;
        console.log(`[${new Date().toISOString()}] Backend :${port} handled ${req.method} ${req.url} (${duration}ms)`);

        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Backend-Port': String(port),
        });
        res.end(`Hello from backend on port ${port}\n`);
      }, 100);
    });

    req.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] Backend :${port} request error:`, err.message);
    });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[Backend :${port}] Server listening on http://127.0.0.1:${port}`);
    console.log(`[Backend :${port}] - Work endpoint: any route (100ms simulated delay)`);
    console.log(`[Backend :${port}] - Health check:  GET /health (instant 200 OK)`);
  });

  server.on('error', (err) => {
    console.error(`[Backend :${port}] Fatal server error:`, err.message);
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log(`\n[Backend :${port}] Shutting down gracefully...`);
    server.close(() => {
      console.log(`[Backend :${port}] Closed all connections.`);
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
