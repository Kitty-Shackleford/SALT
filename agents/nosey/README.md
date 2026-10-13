Nosey — License & dependency auditor

Purpose

Nosey inspects project licensing to surface potential incompatibilities or missing license metadata in dependencies. It provides quick feedback on pull requests and scheduled scans:

Checks performed

- Verifies repository LICENSE file exists
- Verifies root package.json and bot/package.json (if present) declare a license
- After dependencies are installed, scans node_modules and reports packages with missing or unknown license fields
- Flags obvious 'UNLICENSED' or missing license fields as high severity

Behavior

- Runs in CI where dependencies are installed (workflow uses npm ci)
- Emits GitHub Actions annotations and exits non-zero on high-severity findings
- Lightweight and dependency-free: uses Node.js built-ins

Extending

- Integrate with upstream SPDX license lists for robust parsing
- Allow a configurable whitelist of acceptable licenses
- Produce a report artifact listing all dependency licenses

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>