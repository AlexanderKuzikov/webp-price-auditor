# webp-price-auditor

`webp-price-auditor` — batch-инструмент для проверки правильности цен в именах файлов изображений.

Утилита рекурсивно обходит папку с изображениями, извлекает цену из имени файла по шаблону `__ЦЕНА` перед расширением, отправляет изображение в vision-модель, распознаёт цену с картинки и сравнивает её с ценой из имени файла.

Если цена совпала — файл считается `MATCH` и не трогается.
Если цена не совпала (`MISMATCH`) или модель не смогла надёжно распознать цену (`RECHECK_FAIL`) — файл копируется в отдельную папку для ручной проверки.

## Назначение

Проект нужен для массовой валидации товарных изображений, где цена зашита в имени файла и должна совпадать с ценником, стикером или текстом на картинке.

Типовой сценарий:

- есть каталог изображений после выгрузки из CMS, DAM, маркетплейса или фотоархива;
- в имени каждого файла записана ожидаемая цена;
- нужно быстро найти файлы, где цена на изображении отличается от имени файла;
- нужно сохранять подозрительные файлы в отдельную папку и вести воспроизводимый лог обработки.

## Как работает

Пайплайн обработки:

1. Загружается `config.json` и `.env`.
2. Выполняется рекурсивное сканирование `inputDir`.
3. Из имени файла извлекается цена по шаблону `__(\d+)$` на имени без расширения.
4. Изображение подготавливается для модели: `rotate()` по EXIF, resize до заданной ширины, JPEG-конвертация.
5. Картинка отправляется в OpenAI-compatible `chat/completions` endpoint с `image_url`.
6. Ответ модели парсится в число.
7. Цена из ответа сравнивается с ценой из имени файла.
8. При `MISMATCH` и `RECHECK_FAIL` файл копируется в `auditMismatchDir` без перезаписи существующих файлов.
9. Параллельно пишутся `state.jsonl`, `events.jsonl`, `results.csv`, `summary.json`, `summary.csv`.

## Статусы аудита

- `MATCH` — цена на изображении совпала с ценой из имени файла.
- `MISMATCH` — модель распознала цену, но она отличается от цены из имени файла.
- `RECHECK_FAIL` — модель не смогла распознать цену, API завершился ошибкой после retry или результат нельзя считать надёжным.

## Статусы парсинга

- `ok` — число успешно извлечено из ответа модели.
- `empty` — ответ пустой.
- `no_digits` — в ответе нет цифр.
- `api_error` — транспортная ошибка или неуспешный ответ API.

## Поддерживаемые провайдеры

### local

Локальный OpenAI-compatible сервер, например LM Studio.

Особенности:

- базовый URL по умолчанию: `http://localhost:1234/v1`;
- ключ API не требуется;
- на старте выполняется `probeServer()` и проверка доступности модели.

### cloud

Любой OpenAI-compatible облачный провайдер, например OpenRouter.

Особенности:

- используется Bearer token;
- ключ берётся из `OPENROUTER_API_KEY` или `API_KEY`;
- при запросе могут добавляться заголовки `HTTP-Referer` и `X-Title`.

## Структура проекта

```text
webp-price-auditor/
├── src/
│   ├── index.js
│   ├── config.js
│   ├── scanner.js
│   ├── image.js
│   ├── model-client.js
│   ├── parser.js
│   ├── state.js
│   ├── reporter.js
│   └── rate-controller.js
├── prompts/
│   └── prompt_price.txt
├── config.json
├── .env
├── .env.example
├── .gitignore
└── package.json
```

## Требования

- Node.js 20+
- CommonJS runtime
- зависимости: `sharp`, `dotenv`
- все остальные модули — только built-ins Node.js

## Установка

```bash
npm install
```

## Запуск

```bash
npm start
```

## Конфигурация

Основной конфиг хранится в `config.json`.
Секреты и ключи доступа — в `.env`.
Переменные окружения имеют приоритет над значениями из `config.json`.

Пример конфигурации:

```json
{
  "provider": "cloud",
  "apiBaseUrl": "https://openrouter.ai/api/v1",
  "model": "qwen/qwen2.5-vl-7b-instruct",
  "httpReferer": "",
  "xTitle": "webp-price-auditor",

  "inputDir": "C:\path\to\images",
  "auditMismatchDir": "C:\path\to\_mismatch",
  "logsDir": "C:\path\to\logs",

  "promptFile": "prompts/prompt_price.txt",
  "supportedExtensions": [".webp", ".jpg", ".jpeg", ".png"],

  "imageWidthForModel": 512,
  "jpegQualityForModel": 85,

  "temperature": 0,
  "topP": 1,
  "maxTokens": 16,
  "seed": 42,

  "concurrency": 3,
  "timeoutMs": 30000,
  "maxRetries": 2,
  "retryBaseDelayMs": 2000,

  "stopAfter": 0,
  "resumeFromState": true,
  "overwriteExisting": false,

  "adaptiveSpeed": true,
  "targetLatencyMs": 4000,
  "minGapMs": 100,
  "maxGapMs": 8000,
  "initialGapMs": 300,
  "decreaseStepMs": 100,
  "increaseFactor": 1.7,
  "ewmaAlpha": 0.2,
  "cooldownAfterErrorMs": 3000
}
```

## Формат имени файла

Цена извлекается из имени файла без расширения по шаблону:

```text
__(ЦЕНА)
```

Примеры:

- `photo_2025-12-22__3030.webp` → `3030`
- `item-front__15990.jpg` → `15990`
- `sku-red-label__0.png` → `0`

Если имя файла не содержит шаблон `__(\d+)$`, файл пропускается и учитывается в статистике как `noPrice`.

## Логи и артефакты

В каталоге `logsDir` создаются:

- общий `state.jsonl` — append-only state для resume;
- отдельная папка запуска `run-YYYYMMDD-HHMMSS/`;
- `events.jsonl` — поток событий по ходу обработки;
- `results.csv` — детальные результаты по каждому файлу;
- `summary.json` и `summary.csv` — итоговая статистика запуска.

Поля `results.csv`:

- `finishedAt`
- `sourceKey`
- `sourcePath`
- `priceFromFileName`
- `priceFromModel`
- `auditStatus`
- `parseStatus`
- `retriesUsed`
- `latencyMs`
- `mismatchCopied`
- `rawResponse`
- `errorMessage`

## Resume

Если `resumeFromState=true`, приложение читает все `sourceKey` из `state.jsonl` и не ставит уже обработанные файлы в очередь повторно.

Рекомендуемая стратегия:

- `state.jsonl` хранит только terminal-результаты;
- промежуточные попытки, retry и технические события пишутся только в `events.jsonl`;
- `sourceKey` должен учитывать не только путь, но и характеристики файла, чтобы изменение содержимого под тем же именем не считалось уже обработанным.

## Поведение при ошибках

Retry применяется к временным сбоям:

- timeout;
- сетевые ошибки;
- HTTP `429`;
- HTTP `5xx`.

После исчерпания попыток файл получает статус `RECHECK_FAIL` и копируется в папку ручной проверки.

Неретраибельные ошибки, например `400`, `401`, `403`, `404` и `model not found`, должны завершать обработку файла без лишних повторов.

## Копирование mismatch-файлов

При копировании в `auditMismatchDir` нельзя перезаписывать существующие файлы.

Если имя уже занято, добавляется суффикс:

- `name.ext`
- `name__2.ext`
- `name__3.ext`
- и так далее.

## Ограничение скорости

Для устойчивой batch-обработки используется adaptive rate control:

- глобальный `waitTurn()` gate на старт запросов;
- EWMA latency;
- автоматическое увеличение gap при росте латентности;
- уменьшение gap при стабилизации;
- cooldown после ошибок API.

Это позволяет не упираться в провайдера жёстким фиксированным rate limit и одновременно не разгонять очередь до лавинообразных таймаутов.

## Вывод в консоль

### TTY

Прогресс отображается в 3 строки:

1. прогресс-бар и процент выполнения;
2. счётчики `match/mismatch/fail/error/retry`, gap, EWMA, elapsed, ETA, rate;
3. текущая фаза и текущий файл.

### Non-TTY

При запуске без TTY используется периодический лог прогресса без live redraw.

## Безопасность и ограничения

- `.env` не должен попадать в git;
- для cloud-режима API ключ хранится только в переменных окружения;
- `logsDir` и `auditMismatchDir` не должны рекурсивно пересканироваться, если находятся внутри `inputDir`;
- проект не использует сторонние HTTP-клиенты;
- транспорт строится на нативном `fetch` и `AbortController`.

## Дальнейшая реализация

Порядок реализации модулей:

1. `package.json`
2. `.env.example`
3. `src/config.js`
4. `src/scanner.js`
5. `src/image.js`
6. `src/model-client.js`
7. `src/parser.js`
8. `src/rate-controller.js`
9. `src/state.js`
10. `src/reporter.js`
11. `src/index.js`

Этот README зафиксирован как рабочая спецификация проекта перед реализацией кода.
