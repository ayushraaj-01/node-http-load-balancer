/**
 * test-client.js - Sequential Request Distribution Test Client
 *
 * Requirements:
 * 1. Sends 30 sequential requests (configurable via CLI argument: node test-client.js [count] [url])
 * 2. Reads the "X-Served-By" response header to identify the backend
 * 3. Prints a table of how many requests each backend served
 * 4. Exits with an error (process.exit(1)) if distribution is not even (when weights are equal)
 */

const http = require('http');

// Configuration from CLI arguments or defaults
const requestCount = parseInt(process.argv[2], 10) || 30;
const targetBaseUrl = process.argv[3] || 'http://127.0.0.1:8000';

/**
 * Helper to execute a single HTTP GET request
 */
function sendRequest(url) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const parsed = new URL(url);

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'LoadBalancer-TestClient/1.0',
        'Accept': '*/*',
      },
      timeout: 6000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const duration = Date.now() - start;
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          servedBy: res.headers['x-served-by'] || 'unknown',
          body: data.trim(),
          duration,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out after 6000ms'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * Fetch stats from load balancer if available
 */
async function fetchStats(baseUrl) {
  try {
    const res = await sendRequest(`${baseUrl}/stats`);
    if (res.statusCode === 200) {
      return JSON.parse(res.body);
    }
  } catch (err) {
    // Balancer stats might not be reachable or non-standard
  }
  return null;
}

async function runTest() {
  console.log(`=======================================================`);
  console.log(`🧪 Load Balancer Distribution Test`);
  console.log(`   Target:       ${targetBaseUrl}`);
  console.log(`   Total Reqs:   ${requestCount} sequential`);
  console.log(`=======================================================\n`);

  // 1. Check balancer readiness and initial stats
  const initialStats = await fetchStats(targetBaseUrl);
  if (initialStats && initialStats.backends) {
    console.log(`Detected ${initialStats.backends.length} backends configured in load balancer:`);
    initialStats.backends.forEach(b => {
      console.log(`  - ${b.host}:${b.port} [Weight: ${b.weight}, Healthy: ${b.healthy}]`);
    });
    console.log('');
  }

  // 2. Track results
  const countsByBackend = {};
  const latencies = [];
  let successfulRequests = 0;
  let failedRequests = 0;

  const testStartTime = Date.now();

  for (let i = 1; i <= requestCount; i++) {
    const paddedIndex = String(i).padStart(String(requestCount).length, '0');
    try {
      const result = await sendRequest(`${targetBaseUrl}/test-${i}`);
      latencies.push(result.duration);

      if (result.statusCode === 200) {
        successfulRequests++;
        const backendKey = result.servedBy;
        countsByBackend[backendKey] = (countsByBackend[backendKey] || 0) + 1;

        console.log(`[Req ${paddedIndex}/${requestCount}] 200 OK <- ${backendKey.padEnd(16)} (${result.duration}ms)`);
      } else {
        failedRequests++;
        console.warn(`[Req ${paddedIndex}/${requestCount}] HTTP ${result.statusCode} <- ${result.servedBy} (${result.duration}ms)`);
      }
    } catch (err) {
      failedRequests++;
      console.error(`[Req ${paddedIndex}/${requestCount}] FAILED: ${err.message}`);
    }
  }

  const totalTimeMs = Date.now() - testStartTime;
  const avgLatency = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1) : 0;

  console.log(`\n=======================================================`);
  console.log(`📊 DISTRIBUTION RESULTS`);
  console.log(`=======================================================`);

  const backendsList = Object.keys(countsByBackend).sort();
  const numBackends = backendsList.length;

  if (numBackends === 0) {
    console.error(`\n❌ Error: No successful responses received from any backend.`);
    process.exit(1);
  }

  // Check if weights are configured equally
  let areWeightsEqual = true;
  if (initialStats && initialStats.backends) {
    const weights = initialStats.backends.map(b => b.weight);
    areWeightsEqual = weights.every(w => w === weights[0]);
  }

  const expectedPerBackend = requestCount / numBackends;
  const isDivisible = requestCount % numBackends === 0;

  // Build display table
  const tableData = backendsList.map(backendKey => {
    const hits = countsByBackend[backendKey];
    const percentage = ((hits / successfulRequests) * 100).toFixed(1) + '%';
    const isEven = isDivisible
      ? hits === expectedPerBackend
      : (hits === Math.floor(expectedPerBackend) || hits === Math.ceil(expectedPerBackend));

    return {
      'Backend': backendKey,
      'Hits': hits,
      'Share': percentage,
      'Expected (Even)': isDivisible ? `${expectedPerBackend}` : `${Math.floor(expectedPerBackend)} - ${Math.ceil(expectedPerBackend)}`,
      'Even?': isEven ? '✅ YES' : '❌ NO',
    };
  });

  console.table(tableData);

  console.log(`Summary:`);
  console.log(`  - Total Requests Sent:   ${requestCount}`);
  console.log(`  - Successful:            ${successfulRequests}`);
  console.log(`  - Failed:                ${failedRequests}`);
  console.log(`  - Total Test Duration:   ${(totalTimeMs / 1000).toFixed(2)}s`);
  console.log(`  - Average Latency:       ${avgLatency}ms`);
  console.log(`=======================================================`);

  // Verify distribution correctness
  if (areWeightsEqual) {
    const hitValues = Object.values(countsByBackend);
    const maxHits = Math.max(...hitValues);
    const minHits = Math.min(...hitValues);
    const maxDiff = maxHits - minHits;

    // When divisible, each backend must have exact same hits (maxDiff === 0).
    // When indivisible, adjacent counts differ by at most 1 (maxDiff <= 1).
    const isDistributionEven = isDivisible ? (maxDiff === 0) : (maxDiff <= 1);

    if (!isDistributionEven || failedRequests > 0) {
      console.error(`\n❌ ERROR: Request distribution is NOT even across backends!`);
      console.error(`Expected ~${expectedPerBackend} requests per backend (max difference: ${isDivisible ? 0 : 1}, actual difference: ${maxDiff}).`);
      process.exit(1);
    } else {
      console.log(`\n🎉 SUCCESS: All ${successfulRequests} requests were distributed perfectly evenly!`);
      process.exit(0);
    }
  } else {
    console.log(`\nℹ️ Note: Weights are configured unevenly. Verifying execution completed without crashes.`);
    if (failedRequests > 0) {
      process.exit(1);
    }
    process.exit(0);
  }
}

runTest().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
