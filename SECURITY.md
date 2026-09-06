# Security Policy

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities, exposed credentials, authentication bypasses, tenant-isolation defects, or financial-integrity issues.

Use GitHub's private vulnerability reporting for this repository:

https://github.com/Kitty-Shackleford/SALT/security/advisories/new

Include affected versions, reproduction steps, impact, and a minimal proof of concept. Remove all real credentials, tokens, player data, guild IDs, provider service IDs, logs, and private infrastructure details.

## Supported versions

Until versioned releases are published, only the current `main` branch receives security fixes. This policy will be updated when the first stable release is tagged.

## Secrets

If a credential is accidentally committed, revoke or rotate it immediately. Deleting the current file does not remove it from Git history.
