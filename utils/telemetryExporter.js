const http = require('./httpRetry');
const axios = require('axios');
const telemetry = require('./telemetry');

let intervalId = null;

async function pushToPushgateway(pushUrl, jobName = 'dayz-dashboard') {
  try {
    const metrics = telemetry.getPrometheusMetrics();
    // Pushgateway expects POST to /metrics/job/<job>
    const target = pushUrl.replace(/\/+$/, '') + `/metrics/job/${encodeURIComponent(jobName)}`;
    // Use axios directly to allow text/plain body
    await axios.post(target, metrics, { headers: { 'Content-Type': 'text/plain' }, timeout: 10000 });
    console.log('📤 Telemetry pushed to Pushgateway');
  } catch (err) {
    console.error('⚠️ Telemetry pushgateway push failed:', err.message);
  }
}

async function pushToHttpEndpoint(url) {
  try {
    const payload = telemetry.getCounters();
    await http.post(url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
    console.log('📤 Telemetry posted to export endpoint');
  } catch (err) {
    console.error('⚠️ Telemetry export failed:', err.message);
  }
}

function startTelemetryExporter() {
  const pushgateway = process.env.TELEMETRY_PUSHGATEWAY_URL;
  const exportUrl = process.env.TELEMETRY_EXPORT_URL;
  const intervalMs = parseInt(process.env.TELEMETRY_EXPORT_INTERVAL_MS || '30000', 10);

  if (!pushgateway && !exportUrl) {
    console.log('ℹ️ Telemetry exporter not configured (set TELEMETRY_PUSHGATEWAY_URL or TELEMETRY_EXPORT_URL)');
    return;
  }

  if (intervalId) clearInterval(intervalId);

  intervalId = setInterval(async () => {
    try {
      if (pushgateway) await pushToPushgateway(pushgateway);
      if (exportUrl) await pushToHttpEndpoint(exportUrl);
    } catch (err) {
      console.error('⚠️ Telemetry exporter error:', err.message);
    }
  }, intervalMs);

  // push immediately once
  (async () => {
    if (pushgateway) await pushToPushgateway(pushgateway);
    if (exportUrl) await pushToHttpEndpoint(exportUrl);
  })();

  console.log(`✅ Telemetry exporter started (interval=${intervalMs}ms)`);
}

function stopTelemetryExporter() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}

module.exports = { startTelemetryExporter, stopTelemetryExporter };
