const fs = require('node:fs');
const path = require('node:path');

const { loadRuntimeConfig } = require('./config');

async function main() {
  const runtime = loadRuntimeConfig();
  const inputDir = path.resolve(runtime.inputDir);
  const auditMismatchDir = path.resolve(runtime.auditMismatchDir);

  const auditFiles = await fs.promises.readdir(auditMismatchDir);
  const auditNames = new Set(auditFiles.filter((f) => path.extname(f)));

  if (auditNames.size === 0) {
    process.stdout.write('auditMismatchDir is empty, nothing to do.\n');
    return;
  }

  const candidates = await collectByNames(inputDir, auditNames);

  let deleted = 0;
  let failed = 0;

  for (const filePath of candidates) {
    try {
      await fs.promises.unlink(filePath);
      process.stdout.write(`[DELETED] ${path.relative(inputDir, filePath)}\n`);
      deleted += 1;
    } catch (error) {
      process.stderr.write(`[FAILED]  ${path.relative(inputDir, filePath)} — ${error.message}\n`);
      failed += 1;
    }
  }

  process.stdout.write(`\nDone. Deleted: ${deleted}  Failed: ${failed}\n`);
  if (failed > 0) process.exitCode = 1;
}

async function collectByNames(dir, names) {
  const results = [];
  await walk(dir, names, results);
  return results;
}

async function walk(dir, names, results) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, names, results);
    } else if (entry.isFile() && names.has(entry.name)) {
      results.push(fullPath);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[ERROR] ${error.message}\n`);
  process.exitCode = 1;
});
