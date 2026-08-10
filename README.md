<p align="center">
  <a href="https://nodejs.org/"><img alt="Node" src="https://img.shields.io/badge/Node-18+-339933?logo=node.js&logoColor=white"></a>
  <a href="https://github.com/lovell/sharp"><img alt="Sharp" src="https://img.shields.io/badge/Sharp-libvips-99CC00?logo=sharp&logoColor=white"></a>
</p>

<h1 align="center">webp-price-auditor</h1>
<p align="center">Batch-аудит цен в именах файлов через vision-модель</p>

---

Извлекает цену из имени файла (шаблон `__ЦЕНА`), отправляет картинку в VLM, сравнивает распознанную цену. Mismatch-файлы копируются на ручную перепроверку.

- **Аудит** — сравнение цены из имени vs VLM-распознавание
- **Маршрутизация** — mismatch → отдельная папка
- **Crop** — обрезка изображений для лучшего распознавания
- **Scan-vertical** — вертикальное сканирование ценников

## Быстрый старт

```bash
git clone https://github.com/AlexanderKuzikov/webp-price-auditor.git
cd webp-price-auditor
npm install
cp .env.example .env   # VLM endpoint

npm start
npm run cleanup        # очистка временных файлов
npm run crop           # обрезка изображений
```

## Документация

- [`docs/CONTEXT.md`](docs/CONTEXT.md) — состояние проекта
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — архитектурные решения

## Статус

**Работает** — batch-аудит с VLM.
