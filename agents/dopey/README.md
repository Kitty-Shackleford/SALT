Dopey — UI smoke tester

Purpose

Dopey runs lightweight headless-browser smoke tests against the frontend to catch regressions quickly. Tests are intentionally small and fast:

- Verify the root page (/) loads with HTTP 200
- Optionally visit key pages (dashboard, admin) and capture simple assertions
- Produce a screenshot artifact on failure for debugging

How it runs

The GitHub Action .github/workflows/dopey.yml starts a simple static server (serving public/) and installs Playwright at runtime, then runs scripts/dopey-smoke.js.

Configuration

- BASE_URL: URL to test (default: http://localhost:8080)
- PAGES: comma-separated list of paths to test (default: "/")

Extending

- Add more page assertions and accessibility checks
- Integrate with visual-regression tools
- Upload screenshots as workflow artifacts on failure

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>