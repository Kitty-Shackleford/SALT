Piper — Release manager

Purpose

Piper automates release tasks for the DayZ Dashboard repository:

- Create a Git release tag (vX.Y.Z) based on package.json or a provided version
- Generate a simple release note from commit messages
- Build Docker images for backend and bot and publish to a registry (optional, requires credentials)

Design

- Lightweight helper script creates annotated tags and prints release notes
- Workflow builds Docker images when a tag is pushed or via manual dispatch; pushing images requires secrets.DOCKER_USERNAME and secrets.DOCKER_PASSWORD

Usage

  # create a tag from package.json version
  node scripts/piper-release.js

  # create a specific tag
  RELEASE_VERSION=1.2.3 node scripts/piper-release.js

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>