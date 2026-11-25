# Траса 3D

Веб-додаток (PWA) для фахівця з промислової вентиляції: відкрити 3D-скан приміщення (Polycam → GLB/GLTF), намалювати в ньому трасу повітропроводу і отримати 3D-модель повітропроводу, а згодом — площі деталей для кошторису.

**Відкрити:**
- **«Траса 3D 2» — нова версія**, у ній ведеться вся подальша робота: https://khromenkoyegor-star.github.io/duct-route-3d/next/
- **«Траса 3D» — стабільна версія 4.1**, незмінна (резервна гілка `stable-v4.1`): https://khromenkoyegor-star.github.io/duct-route-3d/

iPad / iPhone, Safari → «Поділитися» → «На початковий екран» — відкривається на весь екран; дві версії — дві окремі програми.

Скани відкриваються тільки локально на пристрої й нікуди не завантажуються.

- План і статус етапів — [`ROADMAP.md`](ROADMAP.md)
- Правила проєкту — [`CLAUDE.md`](CLAUDE.md)

## Для розробки

```sh
npm ci
npm run dev        # локальний сервер
npm run build      # збірка (з перевіркою типів)
npm test           # тести ядра (Vitest)
npm run test:e2e   # сценарії й скріншоти (Playwright: iPad landscape, iPhone 15 Pro Max)
```

Допоміжне: `npm run make:room` — перегенерувати тестову кімнату 4000 × 2700 × 3000 мм, `npm run make:icons` — PNG-іконки з `public/icons/icon.svg`.

Публікація: GitHub Actions → GitHub Pages після кожного злиття в `main`: `main` — у `/duct-route-3d/next/`, а стара адреса щоразу збирається з незмінного коміту стабільної версії 4.1 (див. `.github/workflows/ci.yml`).
