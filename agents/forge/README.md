Forge — Build & staging deploy

Purpose

Forge builds Docker images for the project and deploys them to a staging environment. It provides a safe, configurable scaffold for continuous delivery.

Features (scaffold)

- Build backend and bot Docker images using Docker Buildx
- Optionally deploy to a staging host via SSH and run docker-compose (requires SSH key and host)
- Workflow triggers on push to `staging` and can be run manually

Configuration

- DEPLOY_HOST: SSH host (user@host) for remote deployment
- DEPLOY_PATH: Path on remote host where the repository and docker-compose.yml live
- SSH_PRIVATE_KEY: SSH key stored in GitHub Secrets
- DOCKER_USERNAME/DOCKER_PASSWORD: Optional registry credentials for pushing images

Safety

- Deployment step is conditional and only runs when DEPLOY_HOST and SSH_PRIVATE_KEY are provided in the workflow
- Builds are always executed in CI; pushing/publishing and remote deploy require secrets

Extending

- Add health checks / smoke tests post-deploy
- Add blue/green or rolling deployments
- Use image tags based on commit SHA or versioning scheme

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>