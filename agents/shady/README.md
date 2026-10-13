Shady — Vulnerability & secret scanner

Purpose

Shady scans the repository for dependency vulnerabilities and possible secrets. It provides quick feedback on pull requests and scheduled scans:

- Runs `npm audit` to surface dependency vulnerabilities (critical/high/medium)
- Scans tracked files for likely secrets (64-hex keys, PEM private keys, common env variable names with values)
- Emits GitHub Actions annotations and exits non-zero for high-severity issues

Design

- Lightweight Node script using only built-in modules and npm audit output
- Runs in CI (GitHub Actions) where dependencies can be installed for accurate audits
- Secret scanning uses heuristics; false positives should be reviewed manually

Usage

Run locally (may need to run `npm ci` first):

  node scripts/shady-scan.js

In CI, the provided workflow .github/workflows/shady.yml installs dependencies and runs the scan on pull requests and weekly.

Extending

- Integrate with Snyk or GitHub Code Scanning for richer vulnerability data
- Add exclusion rules or baseline to reduce noisy findings

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>