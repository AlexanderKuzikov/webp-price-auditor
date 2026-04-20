function parsePrice(rawText, options) {
  const normalizedRawText = typeof rawText === 'string' ? rawText : '';
  const trimmed = normalizeWhitespace(normalizedRawText);

  if (options && options.apiError) {
    return {
      price: null,
      parsedText: trimmed,
      parseStatus: 'api_error',
      isRecognized: false,
    };
  }

  if (!trimmed) {
    return {
      price: null,
      parsedText: '',
      parseStatus: 'empty',
      isRecognized: false,
    };
  }

  const match = trimmed.match(/\d+/);
  if (!match) {
    return {
      price: null,
      parsedText: trimmed,
      parseStatus: 'no_digits',
      isRecognized: false,
    };
  }

  const price = Number.parseInt(match[0], 10);
  return {
    price,
    parsedText: trimmed,
    parseStatus: 'ok',
    isRecognized: price > 0,
  };
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\t\v\f ]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

module.exports = {
  normalizeWhitespace,
  parsePrice,
};
