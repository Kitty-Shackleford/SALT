/* Simple telemetry helper: timing and counters (in-memory) for log sync and parsing.
 * Not a replacement for real metrics — logs durations to console and exposes
 * a Prometheus exposition formatter and simple exporter hook.
 *
 * Adds simple reservoir sampling for quantile estimation to bound memory.
 */
const os = require('os');
const counters = {};

// stats[name] = { count, sum, min, max, sample: [], seen }
const stats = {};
const SAMPLE_SIZE = parseInt(process.env.TELEMETRY_SAMPLE_SIZE || '1000', 10);

function incr(name, value = 1) {
  counters[name] = (counters[name] || 0) + value;
}

function _recordTiming(name, ms) {
  let s = stats[name];
  if (!s) {
    s = { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0, sample: [], seen: 0 };
    stats[name] = s;
  }
  s.count += 1;
  s.seen += 1;
  s.sum += ms;
  if (ms > s.max) s.max = ms;
  if (ms < s.min) s.min = ms;

  // reservoir sampling (algorithm R)
  if (s.sample.length < SAMPLE_SIZE) {
    s.sample.push(ms);
  } else {
    const r = Math.floor(Math.random() * s.seen);
    if (r < SAMPLE_SIZE) s.sample[r] = ms;
  }
}

function recordTiming(name, ms) {
  _recordTiming(name, ms);
}

async function timeAsync(name, fn) {
  const start = Date.now();
  try {
    const res = await fn();
    const dur = Date.now() - start;
    _recordTiming(name, dur);
    console.log(`⏱ [telemetry] ${name}: ${dur}ms`);
    return res;
  } catch (err) {
    const dur = Date.now() - start;
    _recordTiming(name, dur);
    console.log(`⏱ [telemetry] ${name} failed: ${dur}ms`);
    throw err;
  }
}

function getCounters() {
  const s = {};
  for (const [k, v] of Object.entries(stats)) {
    s[k] = { count: v.count, sum: v.sum, avg: v.count ? v.sum / v.count : 0, min: v.min === Number.POSITIVE_INFINITY ? 0 : v.min, max: v.max };
  }
  return { counters: { ...counters }, timings: s };
}

function _sanitizeMetricName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/__+/g, '_').toLowerCase();
}

function _quantilesFromSample(sample, quantiles = [0.5, 0.9, 0.99]) {
  if (!sample || sample.length === 0) return quantiles.map(() => 0);
  const arr = Array.from(sample).sort((a,b)=>a-b);
  return quantiles.map(q => {
    const idx = (arr.length - 1) * q;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return arr[lo];
    const frac = idx - lo;
    return arr[lo] * (1 - frac) + arr[hi] * frac;
  });
}

function getPrometheusMetrics() {
  const lines = [];
  // Counters
  for (const [k, v] of Object.entries(counters)) {
    const metric = 'dayz_counter_' + _sanitizeMetricName(k);
    lines.push(`# HELP ${metric} Counter metric for ${k}`);
    lines.push(`# TYPE ${metric} counter`);
    lines.push(`${metric} ${v}`);
  }

  // Timings: count, sum, avg, max, min, and quantiles p50,p90,p99
  for (const [k, v] of Object.entries(stats)) {
    const base = 'dayz_timing_' + _sanitizeMetricName(k);
    const count = v.count || 0;
    const sum = v.sum || 0;
    const avg = count > 0 ? sum / count : 0;
    const max = v.max || 0;
    const min = v.min === Number.POSITIVE_INFINITY ? 0 : v.min;

    lines.push(`# HELP ${base}_count Number of samples for ${k}`);
    lines.push(`# TYPE ${base}_count gauge`);
    lines.push(`${base}_count ${count}`);

    lines.push(`# HELP ${base}_sum_ms Sum of durations (ms) for ${k}`);
    lines.push(`# TYPE ${base}_sum_ms gauge`);
    lines.push(`${base}_sum_ms ${sum}`);

    lines.push(`# HELP ${base}_avg_ms Average duration (ms) for ${k}`);
    lines.push(`# TYPE ${base}_avg_ms gauge`);
    lines.push(`${base}_avg_ms ${avg}`);

    lines.push(`# HELP ${base}_max_ms Max duration (ms) for ${k}`);
    lines.push(`# TYPE ${base}_max_ms gauge`);
    lines.push(`${base}_max_ms ${max}`);

    lines.push(`# HELP ${base}_min_ms Min duration (ms) for ${k}`);
    lines.push(`# TYPE ${base}_min_ms gauge`);
    lines.push(`${base}_min_ms ${min}`);

    const [p50, p90, p99] = _quantilesFromSample(v.sample, [0.5, 0.9, 0.99]);
    lines.push(`# HELP ${base}_p50_ms Approximate 50th percentile (ms) for ${k}`);
    lines.push(`# TYPE ${base}_p50_ms gauge`);
    lines.push(`${base}_p50_ms ${p50}`);

    lines.push(`# HELP ${base}_p90_ms Approximate 90th percentile (ms) for ${k}`);
    lines.push(`# TYPE ${base}_p90_ms gauge`);
    lines.push(`${base}_p90_ms ${p90}`);

    lines.push(`# HELP ${base}_p99_ms Approximate 99th percentile (ms) for ${k}`);
    lines.push(`# TYPE ${base}_p99_ms gauge`);
    lines.push(`${base}_p99_ms ${p99}`);
  }

  // Instance info
  lines.push(`# HELP dayz_instance_info Basic instance info`);
  lines.push(`# TYPE dayz_instance_info gauge`);
  const instanceMetric = `dayz_instance_info{instance="${os.hostname()}"} 1`;
  lines.push(instanceMetric);

  return lines.join('\n') + '\n';
}

module.exports = { incr, recordTiming, timeAsync, getCounters, getPrometheusMetrics };
