/**
 * Nitrado File Service (with http retry wrapper)
 */

const http = require('../utils/httpRetry');
const { getNitradoBinaryBody, getNitradoFileEntries, getNitradoTransferToken } = require('../utils/nitradoHttp');
const { ensureContainedDirectorySync, resolveContainedPath, writeContainedFileSync } = require('../utils/safePath');
const { isProviderPathWithinRoots } = require('../utils/dayzPlatform');
const path = require('path');

async function downloadDirectoryRecursive(
  token,
  serverId,
  remotePath,
  localBasePath,
  progressCallback,
  authorizedLocalRoot = localBasePath,
  authorizedRemoteRoot = remotePath
) {
  const results = { files: [], dirs: [], errors: [], totalSize: 0 };

  if (process.env.NODE_ENV !== 'production') {
    console.log(`\n📂 Downloading from: ${remotePath}`);
    console.log(`💾 Saving to: ${localBasePath}`);
  }

  try {
    const encodedPath = encodeURIComponent(remotePath);
    const listUrl = `https://api.nitrado.net/services/${serverId}/gameservers/file_server/list?dir=${encodedPath}`;

    const listRes = await http.get(listUrl, {
      headers: { Authorization: 'Bearer ' + token },
      timeout: 15000
    });

    const entries = getNitradoFileEntries(listRes);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`   ✅ Found ${entries.length} entries`);
    }

    for (const entry of entries) {
      try {
        if (!isProviderPathWithinRoots(entry.path, [authorizedRemoteRoot])) {
          results.errors.push({ path: entry.path, error: 'Provider entry escaped the authorized server root' });
          continue;
        }
        if (entry.type === 'dir') {
          const localDirPath = path.join(localBasePath, entry.name);
          if (process.env.NODE_ENV !== 'production') {
            console.log(`   📁 Creating directory: ${entry.name}`);
          }
          ensureContainedDirectorySync(authorizedLocalRoot, path.relative(authorizedLocalRoot, localDirPath));
          results.dirs.push(entry.path);

          if (progressCallback) progressCallback({ type: 'dir', path: entry.path });

          const subResults = await downloadDirectoryRecursive(
            token,
            serverId,
            entry.path,
            localDirPath,
            progressCallback,
            authorizedLocalRoot,
            authorizedRemoteRoot
          );
          results.files.push(...subResults.files);
          results.dirs.push(...subResults.dirs);
          results.errors.push(...subResults.errors);
          results.totalSize += subResults.totalSize;

        } else if (entry.type === 'file') {
          if (entry.name.startsWith('.')) continue;

          if (process.env.NODE_ENV !== 'production') {
            console.log(`   📄 Downloading: ${entry.name} (expected size: ${entry.size} bytes)`);
          }

          const encodedFilePath = encodeURIComponent(entry.path);
          const tokenRes = await http.get(
            `https://api.nitrado.net/services/${serverId}/gameservers/file_server/download?file=${encodedFilePath}`,
            { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 }
          );

          const { url: downloadUrl } = getNitradoTransferToken(tokenRes);

          const fileRes = await http.get(downloadUrl, { responseType: 'arraybuffer', timeout: 30000 });

          const localFilePath = resolveContainedPath(localBasePath, entry.name);
          const fileBody = getNitradoBinaryBody(fileRes);
          writeContainedFileSync(authorizedLocalRoot, path.relative(authorizedLocalRoot, localFilePath), fileBody);

          const actualSize = fileBody.byteLength;
          if (process.env.NODE_ENV !== 'production') {
            console.log(`   ✅ Saved: ${entry.name} (${actualSize} bytes)`);
          }

          results.files.push({ remotePath: entry.path, localPath: localFilePath, size: actualSize });
          results.totalSize += actualSize;

          if (progressCallback) progressCallback({ type: 'file', path: entry.path, size: actualSize });
        }
      } catch (entryErr) {
        console.error(`   ❌ Error with ${entry.name}: ${entryErr.message}`);
        results.errors.push({ path: entry.path, error: entryErr.response?.status === 404 ? 'Not found' : entryErr.message });
      }
    }
  } catch (err) {
    console.error(`   ❌ Error listing ${remotePath}: ${err.message}`);
    results.errors.push({ path: remotePath, error: err.message });
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log(`   📊 Summary for ${remotePath}: ${results.files.length} files, ${(results.totalSize / 1024 / 1024).toFixed(2)} MB\n`);
  }

  return results;
}

module.exports = { downloadDirectoryRecursive };
