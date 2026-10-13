Dozy — Performance profiler

Purpose

Dozy runs lightweight performance checks to capture basic metrics:

- Measures HTTP response times for key endpoints
- Captures memory usage snapshot when run against local node processes
- Emits a short summary report (stdout) and exits with non-zero if thresholds are exceeded

Design

- Simple Node script using built-in http/https to make requests
- Configurable via environment variables (ENDPOINTS, TIMEOUT_MS, THRESHOLD_MS)
- Intended for scheduled runs or on-demand profiling in CI

Extending

- Integrate with Prometheus/Grafana or push metrics to monitoring
- Add more in-depth Node.js CPU/profile capture via `inspector`

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>