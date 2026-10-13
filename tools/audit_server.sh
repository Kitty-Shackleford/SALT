#!/usr/bin/env bash
# Lightweight server audit for admins
# Writes a snapshot/benchmark report to the directory provided (default: ./audits/<timestamp>)
# DO NOT distribute report files with secrets. This script runs only locally.

set -euo pipefail

OUT_DIR=${1:-"./audits/$(date -u +%Y%m%dT%H%M%SZ)"}
mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/server_audit.txt"

echo "Server audit generated: $(date -u)" > "$REPORT"
echo "Host: $(hostname -f)" >> "$REPORT"
echo "User: $(whoami)" >> "$REPORT"

echo "\n--- System ---" >> "$REPORT"
uname -a >> "$REPORT" 2>&1 || true
if command -v lsb_release >/dev/null 2>&1; then lsb_release -a >> "$REPORT" 2>&1 || true; fi
cat /etc/os-release >> "$REPORT" 2>/dev/null || true

echo "\n--- Uptime / Load / Memory / Disk ---" >> "$REPORT"
uptime >> "$REPORT" 2>&1 || true
free -h >> "$REPORT" 2>&1 || true
vmstat 1 5 >> "$REPORT" 2>&1 || true

echo "\nDisk usage (top filesystems)" >> "$REPORT"
df -hT --total | sed -n '1,999p' >> "$REPORT" 2>&1 || true

echo "\n--- Network listeners (ss -tulpn) ---" >> "$REPORT"
if command -v ss >/dev/null 2>&1; then ss -tulpn >> "$REPORT" 2>&1 || netstat -tulpn >> "$REPORT" 2>&1; fi

echo "\n--- Docker / Compose ---" >> "$REPORT"
if command -v docker >/dev/null 2>&1; then docker --version >> "$REPORT" 2>&1 || true; docker ps --no-trunc --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}' >> "$REPORT" 2>&1 || true; fi
if command -v docker-compose >/dev/null 2>&1; then docker-compose --version >> "$REPORT" 2>&1 || true; docker-compose ps >> "$REPORT" 2>&1 || true; fi

echo "\n--- Git repository (cwd) ---" >> "$REPORT"
if [ -d .git ]; then
  git rev-parse --abbrev-ref HEAD >> "$REPORT" 2>&1 || true
  git rev-parse HEAD >> "$REPORT" 2>&1 || true
  git status --porcelain -b >> "$REPORT" 2>&1 || true
  echo "\nRecent commits (last 20):" >> "$REPORT"
  git log -n 20 --pretty=format:'%h %ad %an %s' --date=short >> "$REPORT" 2>&1 || true
else
  echo "Not a git repo in current directory" >> "$REPORT"
fi

echo "\n--- Node / NPM / Processes ---" >> "$REPORT"
node -v >> "$REPORT" 2>&1 || true
npm -v >> "$REPORT" 2>&1 || true
if command -v pm2 >/dev/null 2>&1; then pm2 ls >> "$REPORT" 2>&1 || true; fi

echo "\nNode processes (top mem/cpu)" >> "$REPORT"
ps aux --sort=-%mem | head -n 30 >> "$REPORT" 2>&1 || true

echo "\n--- Application specific ---" >> "$REPORT"
# Count log files and sizes in bin/dayzxb/config (if present)
if [ -d bin/dayzxb/config ]; then
  echo "Log dir: bin/dayzxb/config" >> "$REPORT"
  find bin/dayzxb/config -maxdepth 2 -type f -printf '%s %p\n' | sort -nr | head -n 50 >> "$REPORT" 2>&1 || true
  echo "\nCounts by extension:" >> "$REPORT"
  find bin/dayzxb/config -type f | sed -n 's/^.*\.\([^.]*\)$/\1/p' | sort | uniq -c | sort -nr >> "$REPORT" 2>&1 || true
fi

# DB connection check hint (do not attempt to connect automatically)
echo "\n--- Database ---" >> "$REPORT"
echo "Inspect DB connection settings in .env or docker-compose.yml. This script does not attempt DB connections automatically." >> "$REPORT"

# Memory snapshot via /proc if available
if [ -r /proc/meminfo ]; then
  echo "\n/proc/meminfo snapshot:" >> "$REPORT"
  head -n 20 /proc/meminfo >> "$REPORT" 2>&1 || true
fi

# Summarize disk IO stats (if iostat available)
if command -v iostat >/dev/null 2>&1; then
  echo "\n--- iostat (1s x 3) ---" >> "$REPORT"
  iostat -x 1 3 >> "$REPORT" 2>&1 || true
fi

# Save a small sample of recent logs (if public/logs exist)
if [ -d public/logs ]; then
  mkdir -p "$OUT_DIR/log_samples"
  for f in $(ls -1 public/logs/*.log 2>/dev/null | head -n 5); do
    bn=$(basename "$f")
    tail -n 500 "$f" > "$OUT_DIR/log_samples/${bn}.tail" || true
  done
fi

echo "\nAudit complete. Output written to $OUT_DIR" >> "$REPORT"

echo "Wrote: $REPORT"
