const readline = require('node:readline');

function createReporter(options) {
  const config = options || {};
  const total = Number.isFinite(Number(config.total)) ? Math.max(0, Math.trunc(Number(config.total))) : 0;
  const nonTtyIntervalMs = Number.isFinite(Number(config.nonTtyIntervalMs)) ? Math.max(1000, Math.trunc(Number(config.nonTtyIntervalMs))) : 15000;
  const renderIntervalMs = Number.isFinite(Number(config.renderIntervalMs)) ? Math.max(50, Math.trunc(Number(config.renderIntervalMs))) : 150;
  const stream = config.stream || process.stderr;
  const active = {
    total,
    startedAtMs: Date.now(),
    lastTickAtMs: Date.now(),
    processed: 0,
    match: 0,
    mismatch: 0,
    fail: 0,
    err: 0,
    retry: 0,
    noPrice: 0,
    phase: 'init',
    currentFile: '',
    gapMs: 0,
    ewmaLatencyMs: null,
    renderPending: false,
    finished: false,
    timer: null,
    nonTtyTimer: null,
    renderedLines: 0,
    tty: Boolean(stream && stream.isTTY),
  };

  if (active.tty) {
    active.timer = setInterval(scheduleRender, renderIntervalMs);
    if (typeof active.timer.unref === 'function') {
      active.timer.unref();
    }
  } else {
    active.nonTtyTimer = setInterval(renderNonTty, nonTtyIntervalMs);
    if (typeof active.nonTtyTimer.unref === 'function') {
      active.nonTtyTimer.unref();
    }
  }

  scheduleRender();

  function setTotal(nextTotal) {
    if (Number.isFinite(Number(nextTotal))) {
      active.total = Math.max(0, Math.trunc(Number(nextTotal)));
      scheduleRender();
    }
  }

  function setPhase(phase, currentFile) {
    active.phase = phase || active.phase;
    if (typeof currentFile === 'string') {
      active.currentFile = currentFile;
    }
    scheduleRender();
  }

  function setRateState(snapshot) {
    if (snapshot && typeof snapshot === 'object') {
      if (Number.isFinite(Number(snapshot.gapMs))) {
        active.gapMs = Math.max(0, Math.trunc(Number(snapshot.gapMs)));
      }
      if (Number.isFinite(Number(snapshot.ewmaLatencyMs))) {
        active.ewmaLatencyMs = Math.max(0, Math.trunc(Number(snapshot.ewmaLatencyMs)));
      }
      scheduleRender();
    }
  }

  function addRetry(count) {
    const value = Number.isFinite(Number(count)) ? Math.max(0, Math.trunc(Number(count))) : 1;
    active.retry += value;
    scheduleRender();
  }

  function addNoPrice(count) {
    const value = Number.isFinite(Number(count)) ? Math.max(0, Math.trunc(Number(count))) : 1;
    active.noPrice += value;
    scheduleRender();
  }

  function tick(result) {
    const record = result || {};
    active.processed += 1;
    active.lastTickAtMs = Date.now();

    if (record.auditStatus === 'MATCH') {
      active.match += 1;
    } else if (record.auditStatus === 'MISMATCH') {
      active.mismatch += 1;
    } else if (record.auditStatus === 'RECHECK_FAIL') {
      active.fail += 1;
    }

    if (record.parseStatus === 'api_error' || record.errorMessage) {
      active.err += 1;
    }

    if (Number.isFinite(Number(record.retriesUsed)) && Number(record.retriesUsed) > 0) {
      active.retry += Math.trunc(Number(record.retriesUsed));
    }

    scheduleRender();
  }

  function info(message) {
    printMessage('INFO', message);
  }

  function warn(message) {
    printMessage('WARN', message);
  }

  function error(message) {
    printMessage('ERROR', message);
  }

  function finish() {
    if (active.finished) {
      return;
    }

    active.finished = true;

    if (active.timer) {
      clearInterval(active.timer);
      active.timer = null;
    }

    if (active.nonTtyTimer) {
      clearInterval(active.nonTtyTimer);
      active.nonTtyTimer = null;
    }

    if (active.tty) {
      clearRenderBlock();
      renderNow();
    } else {
      renderNonTty(true);
    }
  }

  function summary(extra) {
    const elapsedMs = Date.now() - active.startedAtMs;
    const snapshot = getSnapshot();
    const payload = {
      totals: snapshot,
      performance: {
        elapsedMs,
        ratePerMinute: calcRatePerMinute(snapshot.processed, elapsedMs),
        gapMs: active.gapMs,
        ewmaLatencyMs: active.ewmaLatencyMs,
      },
      ...((extra && typeof extra === 'object') ? extra : {}),
    };

    const lines = [
      `Processed: ${snapshot.processed}/${snapshot.total}`,
      `MATCH=${snapshot.match} MISMATCH=${snapshot.mismatch} RECHECK_FAIL=${snapshot.fail} ERR=${snapshot.err} RETRY=${snapshot.retry} NOPRICE=${snapshot.noPrice}`,
      `Elapsed: ${formatDuration(elapsedMs)} | Rate: ${calcRatePerMinute(snapshot.processed, elapsedMs)}/min | Gap: ${active.gapMs}ms | EWMA: ${formatNullableMs(active.ewmaLatencyMs)}`,
    ];

    return {
      payload,
      text: lines.join('\n'),
    };
  }

  function getSnapshot() {
    return {
      total: active.total,
      processed: active.processed,
      remaining: Math.max(0, active.total - active.processed),
      match: active.match,
      mismatch: active.mismatch,
      fail: active.fail,
      err: active.err,
      retry: active.retry,
      noPrice: active.noPrice,
      phase: active.phase,
      currentFile: active.currentFile,
    };
  }

  function scheduleRender() {
    if (!active.tty || active.finished) {
      return;
    }
    if (active.renderPending) {
      return;
    }
    active.renderPending = true;
    setImmediate(() => {
      active.renderPending = false;
      if (!active.finished) {
        renderNow();
      }
    });
  }

  function renderNow() {
    if (!active.tty) {
      return;
    }
    const lines = buildLines();
    clearRenderBlock();
    stream.write(lines.join('\n') + '\n');
    active.renderedLines = lines.length;
  }

  function renderNonTty(force) {
    if (active.tty) {
      return;
    }
    const lines = buildLines();
    const prefix = force ? '[final]' : '[progress]';
    stream.write(prefix + ' ' + lines.join(' | ') + '\n');
  }

  function clearRenderBlock() {
    if (!active.tty || active.renderedLines <= 0) {
      return;
    }

    // Поднимаемся на начало блока (курсор сейчас на строке ПОСЛЕ последней)
    readline.moveCursor(stream, 0, -active.renderedLines);
    readline.cursorTo(stream, 0);

    // Очищаем каждую строку блока сверху вниз
    for (let index = 0; index < active.renderedLines; index += 1) {
      readline.clearLine(stream, 0);
      if (index < active.renderedLines - 1) {
        readline.moveCursor(stream, 0, 1);
      }
    }

    // Возвращаемся на начало блока
    readline.moveCursor(stream, 0, -(active.renderedLines - 1));
    readline.cursorTo(stream, 0);

    active.renderedLines = 0;
  }

  function printMessage(level, message) {
    const text = `[${level}] ${String(message || '')}`;
    if (active.tty && !active.finished) {
      clearRenderBlock();
      stream.write(text + '\n');
      renderNow();
      return;
    }
    stream.write(text + '\n');
  }

  function buildLines() {
    const processed = active.processed;
    const totalSafe = active.total > 0 ? active.total : 0;
    const percent = totalSafe > 0 ? Math.min(100, Math.round((processed / totalSafe) * 100)) : 0;
    const elapsedMs = Date.now() - active.startedAtMs;
    const etaMs = calculateEtaMs(processed, totalSafe, elapsedMs);
    const bar = makeProgressBar(processed, totalSafe, 24);
    const currentFile = truncateMiddle(active.currentFile || '-', 110);

    return [
      `${bar} ${processed}/${totalSafe} ${padLeft(percent, 3)}%`,
      `match:${active.match} mismatch:${active.mismatch} fail:${active.fail} err:${active.err} retry:${active.retry} gap:${active.gapMs}ms ewma:${formatNullableMs(active.ewmaLatencyMs)} elapsed:${formatDuration(elapsedMs)} eta:${formatDuration(etaMs)} rate:${calcRatePerMinute(processed, elapsedMs)}/min`,
      `phase:${active.phase}  file:${currentFile}`,
    ];
  }

  return {
    addNoPrice,
    addRetry,
    error,
    finish,
    getSnapshot,
    info,
    setPhase,
    setRateState,
    setTotal,
    summary,
    tick,
    warn,
  };
}

function makeProgressBar(processed, total, width) {
  if (total <= 0) {
    return `[${'░'.repeat(width)}]`;
  }
  const ratio = Math.max(0, Math.min(1, processed / total));
  const filled = Math.round(ratio * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}]`;
}

function calculateEtaMs(processed, total, elapsedMs) {
  if (processed <= 0 || total <= 0 || processed >= total) {
    return 0;
  }
  const rate = processed / elapsedMs;
  if (!Number.isFinite(rate) || rate <= 0) {
    return 0;
  }
  return Math.round((total - processed) / rate);
}

function calcRatePerMinute(processed, elapsedMs) {
  if (elapsedMs <= 0) {
    return 0;
  }
  return Math.round((processed / elapsedMs) * 60000);
}

function formatDuration(ms) {
  const safe = Math.max(0, Math.round(Number(ms) || 0));
  const totalSeconds = Math.floor(safe / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h${pad2(minutes)}m${pad2(seconds)}s`;
  }
  return `${minutes}m${pad2(seconds)}s`;
}

function formatNullableMs(value) {
  if (!Number.isFinite(Number(value))) {
    return '-';
  }
  return `${Math.max(0, Math.trunc(Number(value)))}ms`;
}

function truncateMiddle(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  const keep = Math.max(8, maxLength - 3);
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${text.slice(0, left)}...${text.slice(text.length - right)}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function padLeft(value, width) {
  return String(value).padStart(width, ' ');
}

module.exports = {
  createReporter,
  formatDuration,
  truncateMiddle,
};
