const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function scanInputFiles(options) {
  const {
    inputDir,
    supportedExtensions,
    excludeDirs = [],
    stopAfter = 0,
    onWarn = null,
  } = options || {};

  if (!inputDir) {
    throw new Error('scanInputFiles requires inputDir');
  }

  if (!Array.isArray(supportedExtensions) || supportedExtensions.length === 0) {
    throw new Error('scanInputFiles requires supportedExtensions');
  }

  const normalizedInputDir = path.resolve(inputDir);
  const normalizedExtensions = new Set(
    supportedExtensions.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
  );
  const excluded = new Set(excludeDirs.filter(Boolean).map((item) => path.resolve(item)));

  const items = [];
  const stats = {
    totalEntriesVisited: 0,
    filesVisited: 0,
    directoriesVisited: 0,
    matchedFiles: 0,
    skippedUnsupported: 0,
    skippedExcludedDir: 0,
    skippedSymlink: 0,
    noPrice: 0,
    stopAfterReached: false,
  };

  await walkDirectory(normalizedInputDir);

  return { items, stats };

  async function walkDirectory(currentDir) {
    if (stopAfter > 0 && items.length >= stopAfter) {
      stats.stopAfterReached = true;
      return;
    }

    stats.directoriesVisited += 1;
    let dirEntries;

    try {
      dirEntries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Failed to read directory: ${currentDir}. ${error.message}`);
    }

    dirEntries.sort((left, right) => left.name.localeCompare(right.name, 'en'));

    for (const dirent of dirEntries) {
      if (stopAfter > 0 && items.length >= stopAfter) {
        stats.stopAfterReached = true;
        return;
      }

      stats.totalEntriesVisited += 1;
      const fullPath = path.join(currentDir, dirent.name);

      if (dirent.isSymbolicLink()) {
        stats.skippedSymlink += 1;
        continue;
      }

      if (dirent.isDirectory()) {
        const resolvedDir = path.resolve(fullPath);
        if (excluded.has(resolvedDir)) {
          stats.skippedExcludedDir += 1;
          continue;
        }
        await walkDirectory(resolvedDir);
        continue;
      }

      if (!dirent.isFile()) {
        continue;
      }

      stats.filesVisited += 1;
      const extension = path.extname(dirent.name).toLowerCase();
      if (!normalizedExtensions.has(extension)) {
        stats.skippedUnsupported += 1;
        continue;
      }

      const priceFromFileName = parsePriceFromFileName(dirent.name);
      if (priceFromFileName === null) {
        stats.noPrice += 1;
        emitWarn(onWarn, `Skipped file without price in name: ${fullPath}`);
        continue;
      }

      const fileStat = await fs.promises.stat(fullPath);
      const relativePath = toPortableRelative(normalizedInputDir, fullPath);
      const sourceKey = buildSourceKey(relativePath, fileStat);

      items.push({
        sourcePath: fullPath,
        relativePath,
        sourceKey,
        fileName: dirent.name,
        priceFromFileName,
        fileSize: fileStat.size,
        mtimeMs: Math.trunc(fileStat.mtimeMs),
      });

      stats.matchedFiles += 1;
    }
  }
}

function parsePriceFromFileName(fileName) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const match = baseName.match(/__(\d+)$/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

function buildSourceKey(relativePath, fileStat) {
  const payload = `${relativePath}|${fileStat.size}|${Math.trunc(fileStat.mtimeMs)}`;
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function toPortableRelative(rootDir, targetPath) {
  return path.relative(rootDir, targetPath).split(path.sep).join('/');
}

function emitWarn(onWarn, message) {
  if (typeof onWarn === 'function') {
    onWarn(message);
  }
}

module.exports = {
  buildSourceKey,
  parsePriceFromFileName,
  scanInputFiles,
  toPortableRelative,
};
