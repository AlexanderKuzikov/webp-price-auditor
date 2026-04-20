class AdaptiveRateController {
  constructor(options) {
    const config = options || {};

    this.adaptiveSpeed = toBoolean(config.adaptiveSpeed, true);
    this.targetLatencyMs = toInteger(config.targetLatencyMs, 4000);
    this.minGapMs = toInteger(config.minGapMs, 100);
    this.maxGapMs = toInteger(config.maxGapMs, 8000);
    this.currentGapMs = clamp(toInteger(config.initialGapMs, 300), this.minGapMs, this.maxGapMs);
    this.decreaseStepMs = Math.max(1, toInteger(config.decreaseStepMs, 100));
    this.increaseFactor = Math.max(1, toFiniteNumber(config.increaseFactor, 1.7));
    this.ewmaAlpha = clamp(toFiniteNumber(config.ewmaAlpha, 0.2), 0.0001, 1);
    this.cooldownAfterErrorMs = Math.max(0, toInteger(config.cooldownAfterErrorMs, 3000));

    this.ewmaLatencyMs = null;
    this.successCount = 0;
    this.failureCount = 0;
    this.cooldownUntil = 0;
    this.nextAllowedAt = 0;
    this.gate = Promise.resolve();
  }

  async waitTurn() {
    const reservation = this.gate.then(async () => {
      const now = Date.now();
      const blockedUntil = Math.max(this.nextAllowedAt, this.cooldownUntil);
      const waitMs = Math.max(0, blockedUntil - now);

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      const startedAt = Date.now();
      this.nextAllowedAt = startedAt + this.currentGapMs;

      return {
        waitMs,
        gapMs: this.currentGapMs,
        ewmaLatencyMs: this.ewmaLatencyMs,
        cooldownUntil: this.cooldownUntil,
        startedAt,
      };
    });

    this.gate = reservation.catch(() => {});
    return reservation;
  }

  markSuccess(latencyMs) {
    const normalizedLatency = normalizeLatency(latencyMs);
    this.successCount += 1;
    this.updateEwma(normalizedLatency);

    if (!this.adaptiveSpeed || normalizedLatency === null) {
      return this.getSnapshot();
    }

    const upperThreshold = this.targetLatencyMs * 1.15;
    const lowerThreshold = this.targetLatencyMs * 0.92;

    if (this.ewmaLatencyMs !== null && this.ewmaLatencyMs > upperThreshold) {
      this.currentGapMs = clamp(Math.round(this.currentGapMs * this.increaseFactor), this.minGapMs, this.maxGapMs);
    } else if (this.ewmaLatencyMs !== null && this.ewmaLatencyMs < lowerThreshold) {
      this.currentGapMs = clamp(this.currentGapMs - this.decreaseStepMs, this.minGapMs, this.maxGapMs);
    }

    return this.getSnapshot();
  }

  markFailure(latencyMs) {
    const normalizedLatency = normalizeLatency(latencyMs);
    this.failureCount += 1;
    this.updateEwma(normalizedLatency);
    this.currentGapMs = clamp(Math.round(this.currentGapMs * this.increaseFactor), this.minGapMs, this.maxGapMs);
    this.cooldownUntil = Date.now() + this.cooldownAfterErrorMs;
    this.nextAllowedAt = Math.max(this.nextAllowedAt, this.cooldownUntil);
    return this.getSnapshot();
  }

  getSnapshot() {
    return {
      adaptiveSpeed: this.adaptiveSpeed,
      targetLatencyMs: this.targetLatencyMs,
      gapMs: this.currentGapMs,
      ewmaLatencyMs: this.ewmaLatencyMs,
      successCount: this.successCount,
      failureCount: this.failureCount,
      cooldownUntil: this.cooldownUntil,
      nextAllowedAt: this.nextAllowedAt,
    };
  }

  updateEwma(latencyMs) {
    if (latencyMs === null) {
      return;
    }

    if (this.ewmaLatencyMs === null) {
      this.ewmaLatencyMs = latencyMs;
      return;
    }

    this.ewmaLatencyMs = Math.round((this.ewmaAlpha * latencyMs) + ((1 - this.ewmaAlpha) * this.ewmaLatencyMs));
  }
}

function createRateController(options) {
  return new AdaptiveRateController(options);
}

function normalizeLatency(latencyMs) {
  const value = Number(latencyMs);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}

function toInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.trunc(num);
}

function toFiniteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  AdaptiveRateController,
  createRateController,
  sleep,
};
