const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const RESULTS_COLUMNS = [
  'finishedAt',
  'sourceKey',
  'sourcePath',
  'priceFromFileName',
  'priceFromModel',
  'auditStatus',
  'parseStatus',
  'retriesUsed',
  'latencyMs',
  'mismatchCopied',
  'rawResponse',
  'errorMessage',
];

async function createStateStore(runtime) {
  validateRuntime(runtime);

  const startedAt = new Date();
  const runId = formatRunId(startedAt);
  const runDir = path.join(runtime.logsDir, runId);
  await fs.promises.mkdir(runDir, { recursive: true });

  const eventsFilePath = path.join(runDir, 'events.jsonl');
  const resultsFilePath = path.join(runDir, 'results.csv');
  const summaryJsonPath = path.join(runDir, 'summary.json');
  const summaryCsvPath = path.join(runDir, 'summary.csv');
  const stateFilePath = runtime.stateFilePath;

  const processedKeys = runtime.resumeFromState ? await loadProcessedKeys(stateFilePath) : new Set();

  await ensureFileWithHeader(resultsFilePath, RESULTS_COLUMNS);

  const streams = {
    state: fs.createWriteStream(stateFilePath, { flags: 'a', encoding: 'utf8' }),
    events: fs.createWriteStream(eventsFilePath, { flags: 'a', encoding: 'utf8' }),
    results: fs.createWriteStream(resultsFilePath, { flags: 'a', encoding: 'utf8' }),
  };

  let writeQueue = Promise.resolve();

  function enqueueWrite(task) {
    writeQueue = writeQueue.then(task);
    return writeQueue;
  }

  async function appendEvent(event) {
    const record = {
      ts: new Date().toISOString(),
      ...sanitizeObject(event),
    };

    return enqueueWrite(() => writeLine(streams.events, JSON.stringify(record)));
  }

  async function appendResult(result) {
    const record = normalizeResultRecord(result);
    processedKeys.add(record.sourceKey);

    return enqueueWrite(async () => {
      await writeCsvRow(streams.results, RESULTS_COLUMNS, record);
      await writeLine(streams.state, JSON.stringify({
        finishedAt: record.finishedAt,
        sourceKey: record.sourceKey,
        sourcePath: record.sourcePath,
        auditStatus: record.auditStatus,
        parseStatus: record.parseStatus,
      }));
    });
  }

  async function writeSummary(summary) {
    const payload = normalizeSummaryPayload({
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      provider: runtime.provider,
      model: runtime.model,
      inputDir: runtime.inputDir,
      auditMismatchDir: runtime.auditMismatchDir,
      logsDir: runtime.logsDir,
      ...sanitizeObject(summary),
    });

    await enqueueWrite(async () => {
      await fs.promises.writeFile(summaryJsonPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      await fs.promises.writeFile(summaryCsvPath, buildSummaryCsv(payload), 'utf8');
    });

    return payload;
  }

  async function close() {
    await writeQueue;
    await Promise.all([
      closeStream(streams.state),
      closeStream(streams.events),
      closeStream(streams.results),
    ]);
  }

  return {
    runId,
    runDir,
    startedAt,
    processedKeys,
    paths: {
      runDir,
      stateFilePath,
      eventsFilePath,
      resultsFilePath,
      summaryJsonPath,
      summaryCsvPath,
    },
    appendEvent,
    appendResult,
    writeSummary,
    close,
  };
}

async function loadProcessedKeys(stateFilePath) {
  const processedKeys = new Set();

  try {
    await fs.promises.access(stateFilePath, fs.constants.F_OK);
  } catch (_) {
    return processedKeys;
  }

  const input = fs.createReadStream(stateFilePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.sourceKey === 'string' && parsed.sourceKey) {
          processedKeys.add(parsed.sourceKey);
        }
      } catch (_) {
      }
    }
  } finally {
    rl.close();
    input.close();
  }

  return processedKeys;
}

async function ensureFileWithHeader(filePath, columns) {
  let stat = null;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (_) {
  }

  if (stat && stat.size > 0) {
    return;
  }

  await fs.promises.writeFile(filePath, `${columns.map(csvEscape).join(',')}\n`, 'utf8');
}

function normalizeResultRecord(record) {
  const safe = sanitizeObject(record);

  return {
    finishedAt: asString(safe.finishedAt) || new Date().toISOString(),
    sourceKey: asString(safe.sourceKey),
    sourcePath: asString(safe.sourcePath),
    priceFromFileName: asNullableNumber(safe.priceFromFileName),
    priceFromModel: asNullableNumber(safe.priceFromModel),
    auditStatus: asString(safe.auditStatus),
    parseStatus: asString(safe.parseStatus),
    retriesUsed: asInteger(safe.retriesUsed, 0),
    latencyMs: asNullableNumber(safe.latencyMs),
    mismatchCopied: asBooleanString(safe.mismatchCopied),
    rawResponse: asString(safe.rawResponse),
    errorMessage: asString(safe.errorMessage),
  };
}

function normalizeSummaryPayload(summary) {
  const flat = flattenObject(summary);
  const normalized = {};

  for (const [key, value] of Object.entries(flat)) {
    normalized[key] = normalizeScalar(value);
  }

  return normalized;
}

function buildSummaryCsv(summary) {
  const keys = Object.keys(summary).sort();
  const header = 'key,value\n';
  const rows = keys.map((key) => `${csvEscape(key)},${csvEscape(summary[key])}`).join('\n');
  return header + rows + (rows ? '\n' : '');
}

function flattenObject(input, prefix = '', output = {}) {
  if (input === null || input === undefined) {
    if (prefix) {
      output[prefix] = '';
    }
    return output;
  }

  if (Array.isArray(input)) {
    output[prefix] = JSON.stringify(input);
    return output;
  }

  if (typeof input !== 'object') {
    output[prefix] = input;
    return output;
  }

  for (const [key, value] of Object.entries(input)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenObject(value, nextKey, output);
    } else {
      output[nextKey] = value;
    }
  }

  return output;
}

function sanitizeObject(input) {
  if (!input || typeof input !== 'object') {
    return {};
  }
  return input;
}

function normalizeScalar(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

function asString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function asNullableNumber(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : '';
}

function asInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.trunc(number);
}

function asBooleanString(value) {
  return value ? 'true' : 'false';
}

function formatRunId(date) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  return `run-${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function csvEscape(value) {
  const stringValue = value === null || value === undefined ? '' : String(value);
  if (!/[",\n\r]/.test(stringValue)) {
    return stringValue;
  }
  return '"' + stringValue.replace(/"/g, '""') + '"';
}

function writeCsvRow(stream, columns, record) {
  const line = columns.map((column) => csvEscape(record[column])).join(',') + '\n';
  return writeLine(stream, line, true);
}

function writeLine(stream, line, rawAlreadyEscaped = false) {
  const payload = rawAlreadyEscaped ? line : `${line}\n`;
  return new Promise((resolve, reject) => {
    stream.write(payload, 'utf8', (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function validateRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    throw new Error('createStateStore requires runtime');
  }
  if (!runtime.logsDir) {
    throw new Error('runtime.logsDir is required');
  }
  if (!runtime.stateFilePath) {
    throw new Error('runtime.stateFilePath is required');
  }
}

module.exports = {
  RESULTS_COLUMNS,
  createStateStore,
  csvEscape,
  formatRunId,
  loadProcessedKeys,
};
