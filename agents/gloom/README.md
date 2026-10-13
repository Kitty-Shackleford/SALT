Gloom — Crash monitor

Purpose

Gloom parses DayZ server RPT and log files downloaded into downloads/ and detects crashes, unhandled exceptions, and restart events. It provides quick feedback in CI and can be extended to notify external channels.

How it works (scaffold)

- Scans downloads/ for .RPT files recursively
- Reads the tail of each file and looks for crash signatures
- Emits GitHub Actions annotations and exits non-zero when crashes are found

Usage

  node scripts/gloom-parse-rpt.js

Extending

- Post crash summaries to Discord or open GitHub issues automatically
- Store parsed events in a DB for trend analysis

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>