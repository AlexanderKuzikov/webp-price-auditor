const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');

const DEFAULTS = Object.freeze({
  provider: 'cloud',
  apiBaseUrl: 'https://api.vsellm.ru/v1',
  model: 'qwen/qwen3.5-flash',
  httpReferer: '',
  xTitle: 'webp-price-auditor',
  inputDir: '',
  auditMismatchDir: '',
  logsDir: '',
  promptFile: 'prompts/prompt_price.txt',
  supportedExtensions: ['.webp', '.jpg', '.jpeg', '.png'],
  imageWidthForModel: 512,
  jpegQualityForModel: 85,
  temperature: 0,
  topP: 1,
  maxTokens: 16,
  seed: 42,
  concurrency: 3,
  timeoutMs: 30000,
  maxRetries: 2,
  retryBaseDelayMs: 2000,
  stopAfter: 0,
  resumeFromState: true,
  overwriteExisting: false,
  adaptiveSpeed: true,
  targetLatencyMs: 4000,
  minGapMs: 100,
  maxGapMs: 8000,
  initialGapMs: 300,
  decreaseStepMs: 100,
  increaseFactor: 1.7,
  ewmaAlpha: 0.2,
  cooldownAfterErrorMs: 3000,
});

const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

function loadRuntimeConfig() {
  loadDotEnv();

  const rawConfig = readConfigFile(CONFIG_PATH);
  const merged = applyEnvOverrides({ ...DEFAULTS, ...rawConfig }, process.env);
  const normalized = normalizeConfig(merged);
  validateConfig(normalized);
  return buildRuntime(normalized);
}

function loadDotEnv() {
  dotenv.config({ path: ENV_PATH });
}

function readConfigFile(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(`config.json not found or unreadable: ${configPath}. ${error.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (strictError) {
    const relaxedRaw = normalizeRelaxedJsonBackslashes(raw);
    try {
      return JSON.parse(relaxedRaw);
    } catch (relaxedError) {
      throw new Error(
        `config.json parse failed. Strict JSON error: ${strictError.message}. Relaxed JSON error: ${relaxedError.message}`
      );
    }
  }
}

function normalizeRelaxedJsonBackslashes(raw) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (!inString) {
      if (char === '"') {
        inString = true;
      }
      result += char;
      continue;
    }

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      const next = raw[index + 1] || '';
      if (VALID_JSON_ESCAPES.has(next)) {
        result += char;
        escaped = true;
      } else {
        result += '\\\\';
      }
      continue;
    }

    if (char === '"') {
      inString = false;
      result += char;
      continue;
    }

    result += char;
  }

  return result;
}

function applyEnvOverrides(config, env) {
  const next = { ...config };

  assignIfDefined(next, 'provider', env.PROVIDER);
  assignIfDefined(next, 'apiBaseUrl', env.API_BASE_URL);
  assignIfDefined(next, 'model', env.MODEL);
  assignIfDefined(next, 'httpReferer', env.HTTP_REFERER);
  assignIfDefined(next, 'xTitle', env.X_TITLE);
  assignIfDefined(next, 'inputDir', env.INPUT_DIR);
  assignIfDefined(next, 'auditMismatchDir', env.AUDIT_MISMATCH_DIR);
  assignIfDefined(next, 'logsDir', env.LOGS_DIR);
  assignIfDefined(next, 'promptFile', env.PROMPT_FILE);

  if (env.SUPPORTED_EXTENSIONS) {
    next.supportedExtensions = env.SUPPORTED_EXTENSIONS
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  assignParsedNumber(next, 'imageWidthForModel', env.IMAGE_WIDTH_FOR_MODEL);
  assignParsedNumber(next, 'jpegQualityForModel', env.JPEG_QUALITY_FOR_MODEL);
  assignParsedNumber(next, 'temperature', env.TEMPERATURE);
  assignParsedNumber(next, 'topP', env.TOP_P);
  assignParsedNumber(next, 'maxTokens', env.MAX_TOKENS);
  assignParsedNumber(next, 'seed', env.SEED);
  assignParsedNumber(next, 'concurrency', env.CONCURRENCY);
  assignParsedNumber(next, 'timeoutMs', env.TIMEOUT_MS);
  assignParsedNumber(next, 'maxRetries', env.MAX_RETRIES);
  assignParsedNumber(next, 'retryBaseDelayMs', env.RETRY_BASE_DELAY_MS);
  assignParsedNumber(next, 'stopAfter', env.STOP_AFTER);
  assignParsedBoolean(next, 'resumeFromState', env.RESUME_FROM_STATE);
  assignParsedBoolean(next, 'overwriteExisting', env.OVERWRITE_EXISTING);
  assignParsedBoolean(next, 'adaptiveSpeed', env.ADAPTIVE_SPEED);
  assignParsedNumber(next, 'targetLatencyMs', env.TARGET_LATENCY_MS);
  assignParsedNumber(next, 'minGapMs', env.MIN_GAP_MS);
  assignParsedNumber(next, 'maxGapMs', env.MAX_GAP_MS);
  assignParsedNumber(next, 'initialGapMs', env.INITIAL_GAP_MS);
  assignParsedNumber(next, 'decreaseStepMs', env.DECREASE_STEP_MS);
  assignParsedNumber(next, 'increaseFactor', env.INCREASE_FACTOR);
  assignParsedNumber(next, 'ewmaAlpha', env.EWMA_ALPHA);
  assignParsedNumber(next, 'cooldownAfterErrorMs', env.COOLDOWN_AFTER_ERROR_MS);

  const apiKey = pickFirstNonEmpty(env.OPENROUTER_API_KEY, env.API_KEY);
  if (apiKey !== undefined) {
    next.apiKey = apiKey;
  }

  return next;
}

function normalizeConfig(config) {
  const next = { ...config };

  next.provider = String(next.provider || '').trim().toLowerCase();
  next.apiBaseUrl = String(next.apiBaseUrl || '').trim().replace(/\/+$/, '');
  next.model = String(next.model || '').trim();
  next.httpReferer = String(next.httpReferer || '').trim();
  next.xTitle = String(next.xTitle || '').trim();
  next.inputDir = resolveFromRoot(String(next.inputDir || '').trim());
  next.auditMismatchDir = resolveFromRoot(String(next.auditMismatchDir || '').trim());
  next.logsDir = resolveFromRoot(String(next.logsDir || '').trim());
  next.promptFile = String(next.promptFile || '').trim();
  next.promptFilePath = resolveFromRoot(next.promptFile);
  next.supportedExtensions = normalizeExtensions(next.supportedExtensions);
  next.apiKey = typeof next.apiKey === 'string' ? next.apiKey.trim() : '';

  next.imageWidthForModel = toInteger(next.imageWidthForModel);
  next.jpegQualityForModel = toInteger(next.jpegQualityForModel);
  next.temperature = toFiniteNumber(next.temperature);
  next.topP = toFiniteNumber(next.topP);
  next.maxTokens = toInteger(next.maxTokens);
  next.seed = toInteger(next.seed);
  next.concurrency = toInteger(next.concurrency);
  next.timeoutMs = toInteger(next.timeoutMs);
  next.maxRetries = toInteger(next.maxRetries);
  next.retryBaseDelayMs = toInteger(next.retryBaseDelayMs);
  next.stopAfter = toInteger(next.stopAfter);
  next.resumeFromState = toBoolean(next.resumeFromState);
  next.overwriteExisting = toBoolean(next.overwriteExisting);
  next.adaptiveSpeed = toBoolean(next.adaptiveSpeed);
  next.targetLatencyMs = toInteger(next.targetLatencyMs);
  next.minGapMs = toInteger(next.minGapMs);
  next.maxGapMs = toInteger(next.maxGapMs);
  next.initialGapMs = toInteger(next.initialGapMs);
  next.decreaseStepMs = toInteger(next.decreaseStepMs);
  next.increaseFactor = toFiniteNumber(next.increaseFactor);
  next.ewmaAlpha = toFiniteNumber(next.ewmaAlpha);
  next.cooldownAfterErrorMs = toInteger(next.cooldownAfterErrorMs);

  next.promptText = readPromptText(next.promptFilePath);

  return next;
}

function validateConfig(config) {
  const errors = [];

  if (!['local', 'cloud'].includes(config.provider)) {
    errors.push('provider must be "local" or "cloud"');
  }

  if (!config.apiBaseUrl) {
    errors.push('apiBaseUrl is required');
  }

  if (!config.model) {
    errors.push('model is required');
  }

  if (!config.inputDir) {
    errors.push('inputDir is required');
  }

  if (!config.auditMismatchDir) {
    errors.push('auditMismatchDir is required');
  }

  if (!config.logsDir) {
    errors.push('logsDir is required');
  }

  if (!fs.existsSync(config.inputDir) || !fs.statSync(config.inputDir).isDirectory()) {
    errors.push(`inputDir does not exist or is not a directory: ${config.inputDir}`);
  }

  if (config.supportedExtensions.length === 0) {
    errors.push('supportedExtensions must contain at least one extension');
  }

  if (!Number.isInteger(config.imageWidthForModel) || config.imageWidthForModel < 64) {
    errors.push('imageWidthForModel must be an integer >= 64');
  }

  if (!Number.isInteger(config.jpegQualityForModel) || config.jpegQualityForModel < 1 || config.jpegQualityForModel > 100) {
    errors.push('jpegQualityForModel must be an integer between 1 and 100');
  }

  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    errors.push('concurrency must be an integer >= 1');
  }

  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000) {
    errors.push('timeoutMs must be an integer >= 1000');
  }

  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0) {
    errors.push('maxRetries must be an integer >= 0');
  }

  if (!Number.isInteger(config.retryBaseDelayMs) || config.retryBaseDelayMs < 0) {
    errors.push('retryBaseDelayMs must be an integer >= 0');
  }

  if (!Number.isInteger(config.stopAfter) || config.stopAfter < 0) {
    errors.push('stopAfter must be an integer >= 0');
  }

  if (!Number.isInteger(config.minGapMs) || config.minGapMs < 0) {
    errors.push('minGapMs must be an integer >= 0');
  }

  if (!Number.isInteger(config.maxGapMs) || config.maxGapMs < config.minGapMs) {
    errors.push('maxGapMs must be an integer >= minGapMs');
  }

  if (!Number.isInteger(config.initialGapMs) || config.initialGapMs < config.minGapMs || config.initialGapMs > config.maxGapMs) {
    errors.push('initialGapMs must be between minGapMs and maxGapMs');
  }

  if (!Number.isInteger(config.decreaseStepMs) || config.decreaseStepMs < 1) {
    errors.push('decreaseStepMs must be an integer >= 1');
  }

  if (!Number.isFinite(config.increaseFactor) || config.increaseFactor < 1) {
    errors.push('increaseFactor must be a number >= 1');
  }

  if (!Number.isFinite(config.ewmaAlpha) || config.ewmaAlpha <= 0 || config.ewmaAlpha > 1) {
    errors.push('ewmaAlpha must be a number in (0, 1]');
  }

  if (!Number.isInteger(config.cooldownAfterErrorMs) || config.cooldownAfterErrorMs < 0) {
    errors.push('cooldownAfterErrorMs must be an integer >= 0');
  }

  if (config.provider === 'cloud' && !config.apiKey) {
    errors.push('cloud provider requires OPENROUTER_API_KEY or API_KEY');
  }

  if (samePath(config.inputDir, config.auditMismatchDir)) {
    errors.push('auditMismatchDir must not be the same as inputDir');
  }

  if (samePath(config.inputDir, config.logsDir)) {
    errors.push('logsDir must not be the same as inputDir');
  }

  if (samePath(config.auditMismatchDir, config.logsDir)) {
    errors.push('auditMismatchDir must not be the same as logsDir');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid config:\n- ${errors.join('\n- ')}`);
  }
}

function buildRuntime(config) {
  ensureDirSync(config.auditMismatchDir);
  ensureDirSync(config.logsDir);

  const stateFilePath = path.join(config.logsDir, 'state.jsonl');
  const excludedDirs = uniqueNonEmpty([config.auditMismatchDir, config.logsDir]);

  return Object.freeze({
    ...config,
    projectRoot: PROJECT_ROOT,
    envPath: ENV_PATH,
    configPath: CONFIG_PATH,
    stateFilePath,
    excludedDirs,
  });
}

function readPromptText(promptFilePath) {
  try {
    return fs.readFileSync(promptFilePath, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch (error) {
    throw new Error(`Prompt file not found or unreadable: ${promptFilePath}. ${error.message}`);
  }
}

function resolveFromRoot(inputPath) {
  if (!inputPath) {
    return '';
  }
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(PROJECT_ROOT, inputPath);
}

function normalizeExtensions(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];

  for (const item of source) {
    const ext = String(item || '').trim().toLowerCase();
    if (!ext) {
      continue;
    }
    const withDot = ext.startsWith('.') ? ext : `.${ext}`;
    if (!seen.has(withDot)) {
      seen.add(withDot);
      normalized.push(withDot);
    }
  }

  return normalized;
}

function assignIfDefined(target, key, value) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function assignParsedNumber(target, key, raw) {
  if (raw === undefined || raw === '') {
    return;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable for ${key} must be a finite number`);
  }
  target[key] = value;
}

function assignParsedBoolean(target, key, raw) {
  if (raw === undefined || raw === '') {
    return;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    target[key] = true;
    return;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    target[key] = false;
    return;
  }
  throw new Error(`Environment variable for ${key} must be boolean-like`);
}

function toInteger(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return NaN;
  }
  return Math.trunc(num);
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function samePath(left, right) {
  if (!left || !right) {
    return false;
  }
  return path.resolve(left) === path.resolve(right);
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];
}

module.exports = {
  DEFAULTS,
  loadRuntimeConfig,
  normalizeRelaxedJsonBackslashes,
  readConfigFile,
  resolveFromRoot,
};
