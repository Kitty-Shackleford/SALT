Doc — PR Code-Reviewer

Purpose

Doc is an automated PR code-reviewer agent scaffold. It runs on pull requests and performs quick, focused checks on changed files:
- Finds TODO/FIXME comments
- Flags console.* calls in production code
- Alerts on possible secrets (64-hex strings)
- Verifies AGPL license header exists in modified JS files

How it runs

The GitHub Action .github/workflows/doc-review.yml triggers on pull_request and runs the script at scripts/doc-review.js. The script is intentionally lightweight and dependency-free so it's easy to extend.

Extending

- Add rules to scripts/doc-review.js
- Post GitHub PR comments using octokit when richer feedback is needed
- Integrate with CI to block merges on errors

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>