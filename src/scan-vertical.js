const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { loadRuntimeConfig } = require('./config');
const { createReporter } = require('./reporter');

async function main() {
  const runtime = loadRuntimeConfig();

  const scanSourceDir = path.resolve(runtime.scanSourceDir);
  const forCropDir = path.resolve(runtime.forCropDir);
  const ratio = Number(runtime.verticalRatio) || 1.25;
  const extensions = new Set((runtime.supportedExtensions || ['.webp', '.jpg', '.jpeg', '.png']).map((e) => e.toLowerCase()));

  await fs.promises.mkdir(forCropDir, { recursive: true });

  const files = await collectFiles(scanSourceDir, extensions);

  const reporter = createReporter({ total: files.length });
  reporter.info(`scanSourceDir: ${scanSourceDir}`);
  reporter.info(`forCropDir:    ${forCropDir}`);
  reporter.info(`ratio:         height/width > ${ratio}`);
  reporter.info(`Found: ${files.length} files`);

  let copied = 0;
  let skipped = 0;

  for (const filePath of files) {
    const rel = path.relative(scanSourceDir, filePath);
    reporter.setPhase('scan', rel);

    try {
      const { width, height } = await sharp(filePath).metadata();
      if (height / width > ratio) {
        const dest = path.join(forCropDir, path.basename(filePath));
        await fs.promises.copyFile(filePath, dest);
        copied += 1;
        reporter.tick({ auditStatus: 'MATCH' });
      } else {
        skipped += 1;
        reporter.tick({ auditStatus: 'MATCH' });
      }
    } catch (error) {
      reporter.tick({ auditStatus: 'RECHECK_FAIL', errorMessage: error.message });
    }
  }

  reporter.finish();
  process.stdout.write(`\nCopied: ${copied}  Skipped: ${skipped}\n`);
}

async function collectFiles(dir, extensions) {
  const results = [];
  await walk(dir, extensions, results);
  return results;
}

async function walk(dir, extensions, results) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, extensions, results);
    } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[ERROR] ${error.message}\n`);
  process.exitCode = 1;
});
