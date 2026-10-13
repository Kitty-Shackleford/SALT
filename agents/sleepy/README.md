Sleepy — Nightly maintenance agent

Purpose

Sleepy runs scheduled maintenance tasks to keep the repository runtime environment tidy and manageable. It performs lightweight, safe housekeeping tasks:

- Remove stale files from the downloads directory older than DAYS_TO_KEEP (default 14 days)
- Compress old log files in the logs directory older than COMPRESS_AFTER_DAYS (default 7 days)
- Emit a short summary to stdout which can be captured by CI artifacts

Design goals

- Dependency-free Node script using only built-in modules
- Safe by default — supports DRY_RUN via environment variable
- Configurable via environment variables and easy to extend

Usage

Run locally for testing:

  node scripts/sleepy-maintain.js

Or enable dry-run to see actions without making changes:

  DRY_RUN=1 node scripts/sleepy-maintain.js

Environment variables

- DOWNLOADS_DIR (default: downloads)
- LOGS_DIR (default: logs)
- DAYS_TO_KEEP (default: 14)
- COMPRESS_AFTER_DAYS (default: 7)
- DRY_RUN=1 to preview changes without deleting/compressing

Extending

- Add remote backup (S3, SCP) in a separate step; avoid embedding secrets in the script
- Add DB snapshot logic using pg_dump or database-specific tooling (run with proper credentials)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>