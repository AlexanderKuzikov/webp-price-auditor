const { performance } = require('node:perf_hooks');

async function probeServer(runtime) {
  validateRuntime(runtime);

  if (runtime.provider === 'cloud') {
    if (!runtime.apiKey) {
      throw new Error('Cloud provider requires apiKey');
    }

    return {
      ok: true,
      provider: 'cloud',
      modelFound: true,
      statusCode: 200,
      message: 'Cloud provider configured',
    };
  }

  const baseUrl = stripTrailingSlashes(runtime.apiBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtime.timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const latencyMs = Math.round(performance.now() - startedAt);
    const bodyText = await response.text();
    const payload = safeJsonParse(bodyText);

    if (!response.ok) {
      return {
        ok: false,
        provider: 'local',
        modelFound: false,
        latencyMs,
        statusCode: response.status,
        message: `Probe failed with HTTP ${response.status}`,
        bodyText,
      };
    }

    const models = Array.isArray(payload && payload.data) ? payload.data : [];
    const modelFound = models.some((item) => item && item.id === runtime.model);

    return {
      ok: response.ok && modelFound,
      provider: 'local',
      modelFound,
      latencyMs,
      statusCode: response.status,
      message: modelFound ? 'Model is available on local server' : `Model not found on local server: ${runtime.model}`,
      models: models.map((item) => ({
        id: item && item.id ? item.id : '',
        owned_by: item && item.owned_by ? item.owned_by : '',
      })),
    };
  } catch (error) {
    return {
      ok: false,
      provider: 'local',
      modelFound: false,
      latencyMs: Math.round(performance.now() - startedAt),
      statusCode: 0,
      message: formatTransportError(error),
      errorName: error && error.name ? error.name : 'Error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function inferPrice(runtime, input) {
  validateRuntime(runtime);
  validateInferInput(input);

  const baseUrl = stripTrailingSlashes(runtime.apiBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtime.timeoutMs);
  const startedAt = performance.now();
  const requestBody = buildChatCompletionBody(runtime, input);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(runtime),
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const latencyMs = Math.round(performance.now() - startedAt);
    const bodyText = await response.text();
    const payload = safeJsonParse(bodyText);

    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        statusCode: response.status,
        rawText: '',
        finishReason: null,
        responseId: payload && payload.id ? payload.id : null,
        errorMessage: extractApiError(payload) || `HTTP ${response.status}`,
        retryable: isRetryableResponseStatus(response.status),
        rawBody: bodyText,
      };
    }

    const choice = Array.isArray(payload && payload.choices) ? payload.choices[0] : null;
    const rawText = extractMessageText(choice && choice.message);

    return {
      ok: true,
      latencyMs,
      statusCode: response.status,
      rawText,
      finishReason: choice && choice.finish_reason ? choice.finish_reason : null,
      responseId: payload && payload.id ? payload.id : null,
      errorMessage: '',
      retryable: false,
      rawBody: bodyText,
      usage: payload && payload.usage ? payload.usage : null,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    return {
      ok: false,
      latencyMs,
      statusCode: 0,
      rawText: '',
      finishReason: null,
      responseId: null,
      errorMessage: formatTransportError(error),
      retryable: isRetryableError(error),
      rawBody: '',
      errorName: error && error.name ? error.name : 'Error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildChatCompletionBody(runtime, input) {
  return {
    model: runtime.model,
    temperature: runtime.temperature,
    top_p: runtime.topP,
    max_tokens: runtime.maxTokens,
    seed: runtime.seed,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: input.promptText,
          },
          {
            type: 'image_url',
            image_url: {
              url: input.imageDataUrl,
            },
          },
        ],
      },
    ],
  };
}

function buildHeaders(runtime) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (runtime.provider === 'cloud') {
    headers.Authorization = `Bearer ${runtime.apiKey}`;
    if (runtime.httpReferer) {
      headers['HTTP-Referer'] = runtime.httpReferer;
    }
    if (runtime.xTitle) {
      headers['X-Title'] = runtime.xTitle;
    }
  }

  return headers;
}

function extractMessageText(message) {
  if (!message) {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content.trim();
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((item) => {
        if (!item) {
          return '';
        }
        if (typeof item === 'string') {
          return item;
        }
        if (typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }

  return '';
}

function extractApiError(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  if (payload.error && typeof payload.error.message === 'string') {
    return payload.error.message.trim();
  }

  if (typeof payload.message === 'string') {
    return payload.message.trim();
  }

  return '';
}

function safeJsonParse(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function isRetryableResponseStatus(statusCode) {
  return statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

function isRetryableError(error) {
  if (!error) {
    return false;
  }

  const name = typeof error.name === 'string' ? error.name : '';
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';

  if (name === 'AbortError' || name === 'TimeoutError') {
    return true;
  }

  return (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('socket') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('timed out') ||
    message.includes('timeout')
  );
}

function formatTransportError(error) {
  if (!error) {
    return 'Unknown transport error';
  }
  if (error.name === 'AbortError') {
    return 'Request timed out';
  }
  return error.message || String(error);
}

function stripTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

function validateRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    throw new Error('Runtime config is required');
  }
  if (!runtime.apiBaseUrl) {
    throw new Error('runtime.apiBaseUrl is required');
  }
  if (!runtime.model) {
    throw new Error('runtime.model is required');
  }
  if (!Number.isInteger(runtime.timeoutMs) || runtime.timeoutMs < 1000) {
    throw new Error('runtime.timeoutMs must be an integer >= 1000');
  }
}

function validateInferInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('inferPrice input is required');
  }
  if (!input.promptText || typeof input.promptText !== 'string') {
    throw new Error('inferPrice requires promptText');
  }
  if (!input.imageDataUrl || typeof input.imageDataUrl !== 'string') {
    throw new Error('inferPrice requires imageDataUrl');
  }
}

module.exports = {
  buildChatCompletionBody,
  buildHeaders,
  inferPrice,
  isRetryableError,
  isRetryableResponseStatus,
  probeServer,
};
