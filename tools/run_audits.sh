#!/usr/bin/env bash
# Wrapper to run all audits and produce a single timestamped directory.
# Usage: tools/run_audits.sh config.json

set -euo pipefail

CFG=${1:-}
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUTDIR=./audits/$TS
mkdir -p "$OUTDIR"

echo "Running server audit..."
./tools/audit_server.sh "$OUTDIR" || true

if [ -n "$CFG" ]; then
  echo "Running nitrado audit with config $CFG..."
  node ./tools/nitrado_audit.js "$CFG" "$OUTDIR/nitrado_report.json" || true
else
  echo "Skipping nitrado audit (no config provided). Provide config.json as first arg to include it." 
fi

# If sample files exist in bin/dayzxb/config, run parser benchmark on a small sample
SAMPLE_ADM=$(ls -1 bin/dayzxb/config/*.adm 2>/dev/null | head -n 1 || true)
SAMPLE_RPT=$(ls -1 bin/dayzxb/config/*.RPT 2>/dev/null | head -n 1 || true)
if [ -n "$SAMPLE_ADM" ]; then
  echo "Running parser benchmark on $SAMPLE_ADM..."
  node ./tools/benchmark_parser.js "$SAMPLE_ADM" "$SAMPLE_RPT" > "$OUTDIR/parser_benchmark.json" || true
else
  echo "No ADM samples found; skipping parser benchmark." 
fi

echo "All audits completed. Output: $OUTDIR"
