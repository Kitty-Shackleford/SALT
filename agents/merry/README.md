Merry — Docs & changelog assistant

Purpose

Merry automates small documentation tasks and changelog generation to keep releases discoverable and contributors informed.

Features (scaffold)

- Generates a simple CHANGELOG.md entry by collecting commit messages since the last Git tag
- Prepends an "Unreleased" section (date-stamped) to CHANGELOG.md
- Runs on push to main or via manual dispatch

Design

- Lightweight Node script (scripts/merry-changelog.js) that uses git commit messages as the source of truth
- CI workflow checks out code, runs the script, and commits CHANGELOG.md back to the repo if it changed
- Intentionally conservative: ignores merge commits and skips when no new commits are found

Extending

- Map conventional commit types to changelog sections (Added, Fixed, Changed)
- Integrate with PR descriptions and labels for richer changelog entries
- Automate release tagging after changelog generation

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>