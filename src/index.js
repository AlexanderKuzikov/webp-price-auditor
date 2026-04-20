const fs = require('node:fs');
const path = require('node:path');

const { loadRuntimeConfig } = require('./config');
const { scanInputFiles } = require('./scanner');
const { buildModelDataUrl } = require('./image');
const { inferPrice, probeServer } = require('./model-client');
const { parsePrice } = require('./parser');
const { createStateStore } = require('./state');
const { createReporter } = require('./reporter');
const { createRateController, sleep } = require('./rate-controller');

async function main() {
  let runtime = null;
  let reporter = null;
  let stateStore = null;

  try {
    runtime = loadRuntimeConfig();
    reporter = createReporter({ total: 0 });
    reporter.info(`Starting run with provider=${runtime.provider} model=${runtime.model}`);

    stateStore = await createStateStore(runtime);
    await stateStore.appendEvent({
      type: 'run_started',
      runId: stateStore.runId,
      provider: runtime.provider,
      model: runtime.model,
      inputDir: runtime.inputDir,
      auditMismatchDir: runtime.auditMismatchDir,
      logsDir: runtime.logsDir,
    });

    reporter.setPhase('probe');
    const probe = await probeServer(runtime);
    await stateStore.appendEvent({ type: 'probe', ...probe });

    if (!probe.ok) {
      throw new Error(`Server probe failed: ${probe.message || 'unknown error'}`);
    }

    reporter.info(probe.message || 'Server probe OK');

    reporter.setPhase('scan');
    const scanResult = await scanInputFiles({
      inputDir: runtime.inputDir,
      supportedExtensions: runtime.supportedExtensions,
      excludeDirs: runtime.excludedDirs,
      stopAfter: runtime.stopAfter,
      onWarn: (message) => reporter.warn(message),
    });

    reporter.addNoPrice(scanResult.stats.noPrice);

    const discoveredCount = scanResult.items.length;
    const queue = runtime.resumeFromState
      ? scanResult.items.filter((item) => !stateStore.processedKeys.has(item.sourceKey))
      : scanResult.items.slice();
    const resumeSkipped = discoveredCount - queue.length;

    reporter.setTotal(queue.length);
    reporter.info(`Discovered=${discoveredCount} queued=${queue.length} resumeSkipped=${resumeSkipped} noPrice=${scanResult.stats.noPrice}`);

    await stateStore.appendEvent({
      type: 'scan_complete',
      stats: scanResult.stats,
      discoveredCount,
      queuedCount: queue.length,
      resumeSkipped,
    });

    const rateController = createRateController(runtime);
    reporter.setRateState(rateController.getSnapshot());

    reporter.setPhase('run');
    await runWithConcurrency(queue, runtime.concurrency, (item) =>
      processOne({
        item,
        runtime,
        reporter,
        stateStore,
        rateController,
      })
    );

    reporter.setPhase('summary');
    const summary = reporter.summary({
      run: {
        runId: stateStore.runId,
        provider: runtime.provider,
        model: runtime.model,
        inputDir: runtime.inputDir,
        auditMismatchDir: runtime.auditMismatchDir,
        logsDir: runtime.logsDir,
      },
      queue: {
        discoveredCount,
        queuedCount: queue.length,
        resumeSkipped,
      },
      scan: scanResult.stats,
      output: stateStore.paths,
    });

    const summaryPayload = await stateStore.writeSummary(summary.payload);
    await stateStore.appendEvent({ type: 'run_finished', summary: summaryPayload });
    reporter.finish();
    process.stdout.write(summary.text + '\n');
  } catch (error) {
    const message = formatError(error);

    if (reporter) {
      reporter.error(message);
    } else {
      process.stderr.write(`[ERROR] ${message}\n`);
    }

    if (stateStore) {
      try {
        await stateStore.appendEvent({ type: 'run_failed', errorMessage: message });
      } catch (_) {
      }
    }

    process.exitCode = 1;
  } finally {
    if (reporter) {
      reporter.finish();
    }
    if (stateStore) {
      await stateStore.close();
    }
  }
}

async function processOne(context) {
  const { item, runtime, reporter, stateStore, rateController } = context;

  reporter.setPhase('image', item.relativePath);
  await stateStore.appendEvent({
    type: 'file_started',
    sourceKey: item.sourceKey,
    sourcePath: item.sourcePath,
    relativePath: item.relativePath,
    priceFromFileName: item.priceFromFileName,
  });

  let image = null;
  let inference = null;
  let parsed = null;
  let retriesUsed = 0;
  let copyResult = null;
  let auditStatus = 'RECHECK_FAIL';
  let errorMessage = '';

  try {
    image = await buildModelDataUrl(item.sourcePath, {
      imageWidthForModel: runtime.imageWidthForModel,
      jpegQualityForModel: runtime.jpegQualityForModel,
    });

    await stateStore.appendEvent({
      type: 'image_prepared',
      sourceKey: item.sourceKey,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      originalWidth: image.originalWidth,
      originalHeight: image.originalHeight,
      originalFormat: image.originalFormat,
    });

    const attemptResult = await runInferenceWithRetry({
      item,
      runtime,
      reporter,
      stateStore,
      rateController,
      imageDataUrl: image.dataUrl,
    });

    inference = attemptResult.inference;
    retriesUsed = attemptResult.retriesUsed;
    parsed = inference.ok ? parsePrice(inference.rawText) : parsePrice('', { apiError: true });

    if (!inference.ok || parsed.parseStatus !== 'ok' || !parsed.isRecognized) {
      auditStatus = 'RECHECK_FAIL';
      errorMessage = inference.ok ? '' : inference.errorMessage || '';
    } else if (parsed.price === item.priceFromFileName) {
      auditStatus = 'MATCH';
    } else {
      auditStatus = 'MISMATCH';
    }
  } catch (error) {
    parsed = parsePrice('', { apiError: true });
    inference = {
      ok: false,
      rawText: '',
      rawBody: '',
      latencyMs: '',
      errorMessage: formatError(error),
    };
    retriesUsed = 0;
    auditStatus = 'RECHECK_FAIL';
    errorMessage = inference.errorMessage;
  }

  if (auditStatus !== 'MATCH') {
    try {
      copyResult = await copyToAuditDir(item.sourcePath, runtime.auditMismatchDir, runtime.overwriteExisting);
    } catch (copyError) {
      errorMessage = joinMessages(errorMessage, `Copy failed: ${formatError(copyError)}`);
    }
  }

  const resultRecord = {
    finishedAt: new Date().toISOString(),
    sourceKey: item.sourceKey,
    sourcePath: item.sourcePath,
    priceFromFileName: item.priceFromFileName,
    priceFromModel: parsed && typeof parsed.price === 'number' ? parsed.price : '',
    auditStatus,
    parseStatus: parsed ? parsed.parseStatus : 'api_error',
    retriesUsed,
    latencyMs: inference && inference.latencyMs ? inference.latencyMs : '',
    mismatchCopied: Boolean(copyResult && copyResult.copied),
    rawResponse: pickRawResponse(inference, parsed),
    errorMessage,
  };

  await stateStore.appendResult(resultRecord);
  await stateStore.appendEvent({
    type: 'file_finished',
    sourceKey: item.sourceKey,
    sourcePath: item.sourcePath,
    auditStatus: resultRecord.auditStatus,
    parseStatus: resultRecord.parseStatus,
    retriesUsed: resultRecord.retriesUsed,
    latencyMs: resultRecord.latencyMs,
    mismatchCopied: resultRecord.mismatchCopied,
    copiedTo: copyResult && copyResult.destinationPath ? copyResult.destinationPath : '',
    errorMessage: resultRecord.errorMessage,
  });

  reporter.tick(resultRecord);
}

async function runInferenceWithRetry(context) {
  const { item, runtime, reporter, stateStore, rateController, imageDataUrl } = context;

  let lastInference = null;
  let retriesUsed = 0;

  for (let attempt = 0; attempt <= runtime.maxRetries; attempt += 1) {
    reporter.setPhase(`wait#${attempt + 1}`, item.relativePath);
    const gateState = await rateController.waitTurn();
    reporter.setRateState(gateState);

    reporter.setPhase(`infer#${attempt + 1}`, item.relativePath);
    await stateStore.appendEvent({
      type: 'request_attempt',
      sourceKey: item.sourceKey,
      attempt: attempt + 1,
      gapMs: gateState.gapMs,
      ewmaLatencyMs: gateState.ewmaLatencyMs,
      waitMs: gateState.waitMs,
    });

    const inference = await inferPrice(runtime, {
      promptText: runtime.promptText,
      imageDataUrl,
    });

    lastInference = inference;

    if (inference.ok) {
      reporter.setRateState(rateController.markSuccess(inference.latencyMs));
      retriesUsed = attempt;
      return { inference, retriesUsed };
    }

    reporter.setRateState(rateController.markFailure(inference.latencyMs));

    const canRetry = inference.retryable && attempt < runtime.maxRetries;
    await stateStore.appendEvent({
      type: canRetry ? 'request_retry' : 'request_failed',
      sourceKey: item.sourceKey,
      attempt: attempt + 1,
      statusCode: inference.statusCode,
      latencyMs: inference.latencyMs,
      retryable: inference.retryable,
      errorMessage: inference.errorMessage,
    });

    if (!canRetry) {
      retriesUsed = attempt;
      return { inference, retriesUsed };
    }

    retriesUsed = attempt + 1;
    const delayMs = runtime.retryBaseDelayMs * (attempt + 1);
    reporter.setPhase(`retry_wait#${attempt + 1}`, item.relativePath);
    await sleep(delayMs);
  }

  return {
    inference: lastInference || {
      ok: false,
      rawText: '',
      rawBody: '',
      latencyMs: '',
      errorMessage: 'Inference failed without response',
    },
    retriesUsed,
  };
}

async function copyToAuditDir(sourcePath, auditMismatchDir, overwriteExisting) {
  const sourceResolved = path.resolve(sourcePath);
  const parsed = path.parse(sourceResolved);
  const targetBaseDir = path.resolve(auditMismatchDir);
  await fs.promises.mkdir(targetBaseDir, { recursive: true });

  if (overwriteExisting) {
    const destinationPath = path.join(targetBaseDir, `${parsed.name}${parsed.ext}`);
    await fs.promises.copyFile(sourceResolved, destinationPath);
    return { copied: true, destinationPath };
  }

  for (let attempt = 1; attempt <= 100000; attempt += 1) {
    const suffix = attempt === 1 ? '' : `__${attempt}`;
    const destinationPath = path.join(targetBaseDir, `${parsed.name}${suffix}${parsed.ext}`);

    try {
      await fs.promises.copyFile(sourceResolved, destinationPath, fs.constants.COPYFILE_EXCL);
      return { copied: true, destinationPath };
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Unable to allocate unique mismatch file name for: ${sourceResolved}`);
}

async function runWithConcurrency(items, concurrency, workerFn) {
  if (!Array.isArray(items)) {
    throw new Error('runWithConcurrency requires items array');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('runWithConcurrency requires concurrency >= 1');
  }
  if (typeof workerFn !== 'function') {
    throw new Error('runWithConcurrency requires workerFn');
  }

  let currentIndex = 0;

  async function worker() {
    while (true) {
      const index = currentIndex;
      currentIndex += 1;
      if (index >= items.length) {
        return;
      }
      await workerFn(items[index], index);
    }
  }

  const workers = [];
  const effectiveConcurrency = Math.min(concurrency, Math.max(1, items.length || 1));
  for (let index = 0; index < effectiveConcurrency; index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

function pickRawResponse(inference, parsed) {
  if (inference && inference.ok) {
    return parsed && parsed.parsedText ? parsed.parsedText : inference.rawText || '';
  }
  if (inference && inference.rawBody) {
    return inference.rawBody;
  }
  return '';
}

function joinMessages(...values) {
  return values.filter((value) => typeof value === 'string' && value.trim() !== '').join(' | ');
}

function formatError(error) {
  if (!error) {
    return 'Unknown error';
  }
  return error && error.stack ? error.stack : String(error.message || error);
}

if (require.main === module) {
  main();
}

module.exports = {
  copyToAuditDir,
  main,
  processOne,
  runInferenceWithRetry,
  runWithConcurrency,
};
