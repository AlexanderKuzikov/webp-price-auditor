# webp-price-auditor — Instructions for AI Agents

## Commands
- start: `npm start`
- cleanup: `npm run cleanup`
- crop: `npm run crop`
- scan-vertical: `npm run scan-vertical`

## Conventions
- Node.js, Sharp, dotenv
- VLM (vision-модель) для распознавания цен
- Шаблон имени: `__ЦЕНА`
- Mismatch → копия на ручную перепроверку

## Structure
- Корневые .js скрипты
- `.env` — конфиг VLM

## Do NOT touch
- `.env` — секреты
- `node_modules/`

## Documentation rules
- После работы — обнови docs/CONTEXT.md
- НЕ создавай новых файлов документации без разрешения
