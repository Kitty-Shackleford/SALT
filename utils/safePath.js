'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function normalizeStorageIdentifier(value, label = 'storage identifier') {
  const normalized = typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalRoot(root) {
  const resolvedRoot = path.resolve(root);
  const realRoot = fs.realpathSync(resolvedRoot);
  if (realRoot !== resolvedRoot) throw new Error('Invalid authorized directory');
  const stat = fs.lstatSync(resolvedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid authorized directory');
  return realRoot;
}

function resolveContainedPath(root, untrustedPath) {
  if (typeof root !== 'string' || !root || typeof untrustedPath !== 'string' || !untrustedPath || untrustedPath.includes('\0')) {
    throw new Error('Invalid file path');
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.isAbsolute(untrustedPath)
    ? path.resolve(untrustedPath)
    : path.resolve(resolvedRoot, untrustedPath);
  if (!isContained(resolvedRoot, candidate)) throw new Error('File path is outside the authorized directory');
  return candidate;
}

function resolveExistingContainedPath(root, untrustedPath) {
  const candidate = resolveContainedPath(root, untrustedPath);
  const realRoot = canonicalRoot(root);
  const realCandidate = fs.realpathSync(candidate);
  if (!isContained(realRoot, realCandidate)) throw new Error('File path is outside the authorized directory');
  return realCandidate;
}

function resolveWritableContainedPath(root, untrustedPath) {
  const candidate = resolveContainedPath(root, untrustedPath);
  const realRoot = canonicalRoot(root);
  const realParent = fs.realpathSync(path.dirname(candidate));
  if (!isContained(realRoot, realParent)) throw new Error('File path is outside the authorized directory');
  return candidate;
}

function descriptorPath(fd) {
  return `/proc/self/fd/${fd}`;
}

function assertDescriptorContained(realRoot, fd) {
  const actualPath = fs.realpathSync(descriptorPath(fd));
  if (!isContained(realRoot, actualPath)) throw new Error('File path is outside the authorized directory');
  return actualPath;
}

function openContainedDirectorySync(root, untrustedPath = '.') {
  const candidate = resolveContainedPath(root, untrustedPath);
  const realRoot = canonicalRoot(root);
  let currentFd = fs.openSync(realRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const relative = path.relative(path.resolve(root), candidate);
    const segments = relative === '' ? [] : relative.split(path.sep);
    for (const segment of segments) {
      if (!segment || segment === '.' || segment === '..') throw new Error('Invalid file path');
      const nextFd = fs.openSync(
        `${descriptorPath(currentFd)}/${segment}`,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      fs.closeSync(currentFd);
      currentFd = nextFd;
      assertDescriptorContained(realRoot, currentFd);
    }
    assertDescriptorContained(realRoot, currentFd);
    return { fd: currentFd, realRoot, candidate };
  } catch (error) {
    fs.closeSync(currentFd);
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') throw new Error('Invalid file path');
    throw error;
  }
}

function ensureContainedDirectorySync(root, untrustedPath) {
  const candidate = resolveContainedPath(root, untrustedPath);
  const realRoot = canonicalRoot(root);
  let currentFd = fs.openSync(realRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const relative = path.relative(path.resolve(root), candidate);
    const segments = relative === '' ? [] : relative.split(path.sep);
    for (const segment of segments) {
      if (!segment || segment === '.' || segment === '..') throw new Error('Invalid file path');
      const childPath = `${descriptorPath(currentFd)}/${segment}`;
      try {
        fs.mkdirSync(childPath, { mode: 0o755 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      let nextFd;
      try {
        nextFd = fs.openSync(
          childPath,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (error.code === 'ELOOP' || error.code === 'ENOTDIR') throw new Error('Invalid file path');
        throw error;
      }
      fs.closeSync(currentFd);
      currentFd = nextFd;
      assertDescriptorContained(realRoot, currentFd);
    }
    return candidate;
  } finally {
    fs.closeSync(currentFd);
  }
}

function writeContainedFileSync(root, untrustedPath, data, options = undefined) {
  const candidate = resolveContainedPath(root, untrustedPath);
  const parentRelative = path.relative(path.resolve(root), path.dirname(candidate)) || '.';
  const { fd: parentFd, realRoot } = openContainedDirectorySync(root, parentRelative);
  let fileFd;
  try {
    const anchoredPath = `/proc/self/fd/${parentFd}/${path.basename(candidate)}`;
    fileFd = fs.openSync(anchoredPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o666);
    const stat = fs.fstatSync(fileFd);
    if (!stat.isFile()) throw new Error('Invalid file path');
    assertDescriptorContained(realRoot, fileFd);
    fs.ftruncateSync(fileFd, 0);
    fs.writeFileSync(fileFd, data, options);
  } finally {
    if (fileFd !== undefined) fs.closeSync(fileFd);
    fs.closeSync(parentFd);
  }
}

function writeContainedFileAtomicSync(root, untrustedPath, data, options = undefined) {
  const candidate = resolveContainedPath(root, untrustedPath);
  const parentRelative = path.relative(path.resolve(root), path.dirname(candidate)) || '.';
  const { fd: parentFd } = openContainedDirectorySync(root, parentRelative);
  const destinationPath = `${descriptorPath(parentFd)}/${path.basename(candidate)}`;
  const tempName = `.${path.basename(candidate)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const tempPath = `${descriptorPath(parentFd)}/${tempName}`;
  let tempFd;
  let cleanupError;
  try {
    try {
      const destinationStat = fs.lstatSync(destinationPath);
      if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) throw new Error('Invalid file path');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    tempFd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o666,
    );
    fs.writeFileSync(tempFd, data, options);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;
    fs.renameSync(tempPath, destinationPath);
  } finally {
    if (tempFd !== undefined) fs.closeSync(tempFd);
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (error.code !== 'ENOENT') cleanupError = error;
    }
    try {
      fs.closeSync(parentFd);
    } catch (error) {
      if (!cleanupError) cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
}

function openContainedFileSync(root, untrustedPath) {
  const candidate = resolveContainedPath(root, untrustedPath);
  const parentRelative = path.relative(path.resolve(root), path.dirname(candidate)) || '.';
  const { fd: parentFd, realRoot } = openContainedDirectorySync(root, parentRelative);
  let fileFd;
  try {
    fileFd = fs.openSync(
      `${descriptorPath(parentFd)}/${path.basename(candidate)}`,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(fileFd);
    if (!stat.isFile()) throw new Error('Invalid file path');
    assertDescriptorContained(realRoot, fileFd);
    return { fd: fileFd, stat };
  } catch (error) {
    if (fileFd !== undefined) fs.closeSync(fileFd);
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') throw new Error('Invalid file path');
    throw error;
  } finally {
    fs.closeSync(parentFd);
  }
}

function listContainedDirectorySync(root, untrustedPath = '.') {
  const { fd } = openContainedDirectorySync(root, untrustedPath);
  try {
    return fs.readdirSync(descriptorPath(fd), { withFileTypes: true });
  } finally {
    fs.closeSync(fd);
  }
}

function statContainedFileSync(root, untrustedPath) {
  const { fd, stat } = openContainedFileSync(root, untrustedPath);
  try {
    return stat;
  } finally {
    fs.closeSync(fd);
  }
}

function readContainedFileSync(root, untrustedPath, options = undefined) {
  const { fd: fileFd } = openContainedFileSync(root, untrustedPath);
  try {
    return fs.readFileSync(fileFd, options);
  } finally {
    fs.closeSync(fileFd);
  }
}

module.exports = {
  ensureContainedDirectorySync,
  listContainedDirectorySync,
  normalizeStorageIdentifier,
  openContainedDirectorySync,
  openContainedFileSync,
  readContainedFileSync,
  resolveContainedPath,
  resolveExistingContainedPath,
  resolveWritableContainedPath,
  statContainedFileSync,
  writeContainedFileAtomicSync,
  writeContainedFileSync,
};
