Orchestrator — Command & Control agent

Purpose

Orchestrator triggers and sequences the other agent scripts, aggregates their outputs, and produces a concise report. It is an opinionated, safe coordinator intended to run in CI (manual dispatch or scheduled) or locally by an administrator.

Features (scaffold)

- Run a configurable sequence of existing agent scripts (Doc, Shady, Nosey, Dopey, etc.)
- Capture exit codes, stdout, stderr, and runtime for each agent
- Emit GitHub Actions annotations for failures
- Write a JSON report artifact to reports/orchestrator-<timestamp>.json

Configuration

- Use ORCHESTRATOR_AGENTS env var (comma-separated agent keys) to select and order agents
- Defaults to a sensible set if not provided

Usage

  node scripts/orchestrator.js

Or in CI the workflow .github/workflows/orchestrator.yml runs the orchestrator on demand or schedule.

Extending

- Add orchestration rules (conditional runs, retries, parallel groups)
- Integrate with a dashboard or incident system
- Add authentication/ACLs for a remote API controller

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>