#!/usr/bin/env node
// Nosey — License & dependency auditor (lightweight)

const fs = require('fs');
const path = require('path');

const gha = Boolean(process.env.GITHUB_ACTIONS);
let issues = [];

function emit(file, severity, type, message) {
  issues.push({ file, severity, type, message });
}

function annotateAndExit() {
  let high = 0;
  for (const it of issues) {
    const prefix = it.severity === 'high' ? 'error' : it.severity === 'medium' ? 'warning' : 'notice';
    const file = it.file || '';
    const title = it.type || 'license';
    const msg = it.message || '';
    if (gha) console.log(`::${prefix} file=${file},title=Nosey ${title}::${msg}`);
    console.log(`${it.severity.toUpperCase()}: ${title} ${file ? 'in '+file : ''} - ${msg}`);
    if (it.severity === 'high') high++;
  }

  if (high > 0) {
    console.error(`Nosey: ${high} high severity license issue(s) found`);
    process.exit(4);
  }
  console.log('Nosey: no high-severity license issues found');
  process.exit(0);
}

// 1) Check LICENSE file
function checkRepoLicense() {
  const licensePath = path.join(process.cwd(), 'LICENSE');
  if (!fs.existsSync(licensePath)) {
    emit('', 'high', 'license-missing', 'Repository LICENSE file not found');
    return;
  }
  const text = fs.readFileSync(licensePath, 'utf8');
  if (!/Affero|AGPL|GNU Affero/i.test(text)) {
    emit('LICENSE', 'medium', 'license', 'Repository license file exists but does not mention AGPL/Affero; verify compatibility');
  }
}

// 2) Check package.json license fields in root and bot/
function checkPackageJsons() {
  const roots = ['package.json', 'bot/package.json'];
  for (const p of roots) {
    const full = path.join(process.cwd(), p);
    if (!fs.existsSync(full)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!pkg.license) {
        emit(p, 'high', 'package-license-missing', 'package.json missing `license` field');
      } else if (!/AGPL|Affero|GPL|AGPL-3.0|AGPL-3.0-or-later/i.test(pkg.license)) {
        emit(p, 'medium', 'package-license', `package.json license set to "${pkg.license}" — ensure it is AGPL-compatible`);
      }
    } catch (e) {
      emit(p, 'medium', 'package-json', `Failed to parse ${p}: ${e.message}`);
    }
  }
}

// 3) Scan node_modules for missing/UNLICENSED license metadata
//    Severity model:
//      - Direct production deps without a usable license  -> HIGH (release blocker)
//      - Transitive production deps without a usable license -> MEDIUM
//        (real legal question, but the license question belongs to the direct
//        parent that pulls it; a human review is warranted, not an auto-block)
//      - Dev-only tree problems (lockfile `dev: true`)  -> NOTICE
//        (tooling without license metadata must not red the gate)
function loadLockfile(lockPath) {
  if (!fs.existsSync(lockPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Package names present in at least one production (non-dev) lockfile entry.
function lockfileProdNames(lock) {
  const names = new Set();
  for (const [entryPath, entry] of Object.entries((lock && lock.packages) || {})) {
    if (!entryPath || !entry || entry.dev) continue;
    const segs = entryPath.split('node_modules/');
    const tail = segs.length > 1 ? segs[segs.length - 1] : entryPath;
    names.add(tail.startsWith('@') ? tail.split('/').slice(0, 2).join('/') : tail.split('/')[0]);
  }
  return names;
}

// Which package depends on `name` (lockfile parent lookup) — for review messages.
function lockfileParentOf(lock, name) {
  const want = 'node_modules/' + name;
  for (const [entryPath] of Object.entries((lock && lock.packages) || {})) {
    if (entryPath.endsWith(want) && !entryPath.startsWith(want)) {
      const head = entryPath.slice(0, -want.length);
      const m = head.match(/node_modules\/(@?[^@/]+\/?[^@/]*)/g);
      if (m) return m[m.length - 1].replace('node_modules/', '');
      return head;
    }
  }
  return null;
}

function directDependencyNames() {
  const names = new Set();
  for (const p of ['package.json', 'bot/package.json']) {
    const full = path.join(process.cwd(), p);
    if (!fs.existsSync(full)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(full, 'utf8'));
      for (const d of ['dependencies', 'peerDependencies']) {
        for (const n of Object.keys((pkg && pkg[d]) || {})) names.add(n);
      }
    } catch (e) { /* ignore */ }
  }
  return names;
}

const rootLock = loadLockfile(path.join(process.cwd(), 'package-lock.json'));
const botLock = loadLockfile(path.join(process.cwd(), 'bot/package-lock.json'));
const prodSet = (() => {
  const s = new Set();
  for (const n of lockfileProdNames(rootLock || {})) s.add(n);
  for (const n of lockfileProdNames(botLock || {})) s.add(n);
  return (rootLock || botLock) && s.size > 0 ? s : null;
})();
const directSet = directDependencyNames();
const prodParentCache = {};

function licenseSeverity(name) {
  // prodSet null = no usable lockfile -> old strict behavior
  if (!prodSet) return 'high';
  if (!prodSet.has(name)) return 'notice';      // dev-only
  if (directSet.has(name)) return 'high';      // direct prod dep: release blocker
  if (!(name in prodParentCache)) {
    prodParentCache[name] = lockfileParentOf(rootLock, name) || lockfileParentOf(botLock, name);
  }
  return 'medium'; // transitive prod dep
}

function licenseMessage(name, base) {
  if (prodSet && !prodSet.has(name)) return `${name} (dev-only) — ${base}`;
  if (prodSet && directSet.has(name)) return base;
  const parent = prodParentCache[name] ? ` (pulled by ${prodParentCache[name]})` : '';
  return `${base}${parent} — review the parent's license grant`;
}

function scanNodeModules() {
  const nm = path.join(process.cwd(), 'node_modules');
  if (!fs.existsSync(nm)) {
    console.log('Nosey: node_modules not present; skip deep dependency scan (install deps in CI to enable)');
    return;
  }

  const counts = {};
  const problems = [];

  // traverse top-level packages (including scoped)
  const entries = fs.readdirSync(nm, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '.bin') continue;
    if (e.isDirectory() && e.name.startsWith('@')) {
      // scoped packages
      const scoped = path.join(nm, e.name);
      for (const s of fs.readdirSync(scoped)) {
        const pkgPath = path.join(scoped, s, 'package.json');
        inspectPackage(pkgPath, counts, problems);
      }
    } else if (e.isDirectory()) {
      const pkgPath = path.join(nm, e.name, 'package.json');
      inspectPackage(pkgPath, counts, problems);
    }
  }

  // Emit problems
  for (const p of problems) {
    emit(p.file, p.severity, p.type, p.message);
  }

  const total = Object.values(counts).reduce((a,b)=>a+b,0);
  console.log(`Nosey: scanned ${total} dependency package.json files`);
}

function inspectPackage(pkgPath, counts, problems) {
  if (!fs.existsSync(pkgPath)) return;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const name = pkg.name || pkgPath;
    let lic = pkg.license || (pkg.licenses && Array.isArray(pkg.licenses) ? pkg.licenses.map(l=>l.type||l).join(',') : null);
    // npm reports "SEE LICENSE IN <file>" when a package ships its license in
    // a non-standard file — verify that file actually exists, else treat as missing.
    if (lic && /SEE LICENSE IN/i.test(lic)) {
      const ref = lic.replace(/^SEE LICENSE IN\s+/i, '').trim() || 'LICENSE';
      const file = path.join(path.dirname(pkgPath), ref);
      if (fs.existsSync(file)) {
        // License file exists — a real grant; the field string is just npm's
        // pointer to it, not an "unknown license". Count it and move on.
        counts[`file:${ref}`] = (counts[`file:${ref}`] || 0) + 1;
        return;
      }
      lic = null;
    }
    if (!lic) {
      // On-disk fallback: many packages ship LICENSE/LICENCE without a
      // package.json license field; that is a real license, not a blocker.
      const dir = path.dirname(pkgPath);
      const onDisk = fs.readdirSync(dir).some(f => /^(LICENSE|LICENCE|COPYING)(\.(md|txt|txt|text|rst))?$/i.test(f));
      if (onDisk) {
        counts['on-disk-file'] = (counts['on-disk-file'] || 0) + 1;
        return;
      }
    }
    const sev = licenseSeverity(name);
    counts[lic || 'MISSING'] = (counts[lic || 'MISSING'] || 0) + 1;
    if (!lic) {
      problems.push({ file: pkgPath, severity: sev, type: 'dep-license-missing', message: licenseMessage(name, `${name} has no license field`) });
    } else if (/UNLICENSED|NOASSERTION|NONE/i.test(lic)) {
      problems.push({ file: pkgPath, severity: sev, type: 'dep-license', message: licenseMessage(name, `${name} has license: ${lic}`) });
    } else if (!/MIT|ISC|BSD|Apache|GPL|AGPL|LGPL|MPL|EPL/i.test(lic)) {
      // ambiguous or uncommon license string
      problems.push({ file: pkgPath, severity: sev === 'notice' ? 'notice' : sev, type: 'dep-license-unknown', message: licenseMessage(name, `has uncommon license string: ${lic}`) });
    }
  } catch (e) {
    problems.push({ file: pkgPath, severity: 'medium', type: 'dep-package-parse', message: `Failed to parse package.json: ${e.message}` });
  }
}

// Main
(async () => {
  console.log('Nosey: starting license audit');
  try { checkRepoLicense(); } catch (e) { emit('', 'medium', 'license-check-failed', e.message); }
  try { checkPackageJsons(); } catch (e) { emit('', 'medium', 'pkg-json-check-failed', e.message); }
  try { scanNodeModules(); } catch (e) { emit('', 'medium', 'node-mod-scan-failed', e.message); }

  annotateAndExit();
})();
