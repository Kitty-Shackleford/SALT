#!/usr/bin/env node
// Orchestrator — run and aggregate other agent scripts

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const gha = Boolean(process.env.GITHUB_ACTIONS);

// Default agent mapping: key -> script path
const AGENT_MAP = {
  doc: 'scripts/doc-review.js',
  shady: 'scripts/shady-scan.js',
  nosey: 'scripts/nosey-license-check.js',
  dopey: 'scripts/dopey-smoke.js',
  dozy: 'scripts/dozy-profile.js',
  merry: 'scripts/merry-changelog.js',
  sleepy: 'scripts/sleepy-maintain.js',
  gloom: 'scripts/gloom-parse-rpt.js',
  piper: 'scripts/piper-release.js',
  forge: 'scripts/forge-deploy.js'
};

// Read agent list from env or default order
const agentList = (process.env.ORCHESTRATOR_AGENTS || 'doc,shady,nosey,dopey,dozy,merry,sleepy,gloom,piper,forge')
  .split(',').map(s => s.trim()).filter(Boolean);

function runAgent(agentKey) {
  const script = AGENT_MAP[agentKey];
  if (!script || !fs.existsSync(script)) {
    return { key: agentKey, ok: false, error: `Script not found: ${script || 'unknown'}` };
  }

  console.log(`Orchestrator: running ${agentKey} -> ${script}`);
  const start = Date.now();
  const child = spawnSync('node', [script], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const durationMs = Date.now() - start;

  const result = {
    key: agentKey,
    script,
    status: child.status, // exit code
    signal: child.signal,
    stdout: (child.stdout || '').slice(0, 10000),
    stderr: (child.stderr || '').slice(0, 10000),
    durationMs
  };

  result.ok = result.status === 0;
  return result;
}

function annotateResult(r) {
  const file = r.script || '';
  if (!r.ok) {
    const msg = `Orchestrator: agent ${r.key} failed (exit ${r.status || 'signal '+r.signal})`;
    if (gha) console.log(`::error file=${file},title=Orchestrator ${r.key}::${msg}`);
    console.error(msg);
  } else {
    const msg = `Orchestrator: agent ${r.key} succeeded in ${r.durationMs}ms`;
    if (gha) console.log(`::notice file=${file},title=Orchestrator ${r.key}::${msg}`);
    console.log(msg);
  }
}

(async () => {
  console.log('Orchestrator: starting sequence:', agentList.join(', '));
  const results = [];
  for (const a of agentList) {
    try {
      const res = runAgent(a);
      results.push(res);
      annotateResult(res);
      // Simple policy: stop on first high-severity failure (non-zero)
      if (!res.ok) {
        console.log(`Orchestrator: stopping sequence due to failure in ${a}`);
        break;
      }
    } catch (e) {
      const errRes = { key: a, ok: false, error: e.message };
      results.push(errRes);
      annotateResult(errRes);
      break;
    }
  }

  // write report
  const reportsDir = path.join(process.cwd(), 'reports');
  try { fs.mkdirSync(reportsDir, { recursive: true }); } catch (_) {}
  const reportPath = path.join(reportsDir, `orchestrator-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ timestamp: Date.now(), agents: results }, null, 2));
  console.log('Orchestrator: report written to', reportPath);

  // exit non-zero if any agent failed
  const failed = results.some(r => !r.ok);
  process.exit(failed ? 5 : 0);
})();
