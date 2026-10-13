Audit tools

Purpose
- Small set of admin-only tools for benchmarking and auditing the DayZ Dashboard server and Nitrado services.
- Tools write local reports only; they do NOT transmit data externally.

Files
- tools/audit_server.sh       — system + application snapshot (disk, processes, git, sample logs)
- tools/nitrado_audit.js      — query Nitrado API endpoints for file listings, tasks, and status (requires config.json with tokens)
- tools/benchmark_parser.js   — measure parse time/memory for parseADMFileStream / parseRPTLog
- tools/run_audits.sh         — wrapper that runs the set and writes to ./audits/<timestamp>/

Security / Usage
- Run only as admin or a trusted operator. Reports can contain sensitive info (file listings, partial logs).
- Never commit Nitrado tokens or report files to source control.
- For Nitrado auditing, create a config.json locally (example below) and pass its path to run_audits.sh or nitrado_audit.js.

Example Nitrado config.json
{
  "servers": [
    { "service_id": "12345", "token": "REPLACE_WITH_TOKEN" }
  ]
}

Example
# Run full audits incl. Nitrado (config.json in current dir)
./tools/run_audits.sh ./config.json

# Run only local server audit
./tools/audit_server.sh

Notes
- These scripts are intentionally simple and intended for ad-hoc audits and benchmarking. For repeated scheduled auditing, integrate with your monitoring/secure vault and run from a hardened admin host.
- If you want, add an option to encrypt reports at rest (gpg) or push to an S3 bucket accessible to ops.
