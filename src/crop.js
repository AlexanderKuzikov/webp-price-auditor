const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { loadRuntimeConfig } = require('./config');
const { createReporter } = require('./reporter');

async function main() {
  const runtime = loadRuntimeConfig();

  const inputDir = path.resolve(runtime.cropInputDir || runtime.forCropDir);
  const outputDir = path.resolve(runtime.cropOutputDir);
  const cropTop = Number(runtime.cropTop) || 0;
  const cropBottom = Number(runtime.cropBottom) || 0;
  const extensions = new Set((runtime.supportedExtensions || ['.webp', '.jpg', '.jpeg', '.png']).map((e) => e.toLowerCase()));

  if (cropTop < 0 || cropTop > 50 || cropBottom < 0 || cropBottom > 50) {
    process.stderr.write('[ERROR] cropTop and cropBottom must be between 0 and 50\n');
    process.exitCode = 1;
    return;
  }

  await fs.promises.mkdir(outputDir, { recursive: true });

  const files = await collectFiles(inputDir, extensions);

  const reporter = createReporter({ total: files.length });
  reporter.info(`inputDir:   ${inputDir}`);
  reporter.info(`outputDir:  ${outputDir}`);
  reporter.info(`cropTop:    ${cropTop}%  cropBottom: ${cropBottom}%`);
  reporter.info(`Found: ${files.length} files`);

  for (const filePath of files) {
    const rel = path.relative(inputDir, filePath);
    reporter.setPhase('crop', rel);

    try {
      const meta = await sharp(filePath).metadata();
      const { width, height } = meta;
      const cutTop = Math.round(height * cropTop / 100);
      const cutBottom = Math.round(height * cropBottom / 100);
      const newHeight = height - cutTop - cutBottom;

      if (newHeight <= 0) {
        throw new Error(`Resulting height <= 0 (${height} - ${cutTop} - ${cutBottom})`);
      }

      const destPath = path.join(outputDir, path.basename(filePath));
      await sharp(filePath)
        .extract({ left: 0, top: cutTop, width, height: newHeight })
        .toFile(destPath);

      reporter.tick({ auditStatus: 'MATCH' });
    } catch (error) {
      reporter.tick({ auditStatus: 'RECHECK_FAIL', errorMessage: error.message });
    }
  }

  reporter.finish();
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
