# Detsky Hit — сайт

Публичный сайт в стиле Instagram: сетка товаров, избранное (❤️, localStorage), WhatsApp-кнопка,
админка. Хостинг — **Cloudflare Workers** (статика + Worker), база — **Supabase**.

## Структура

- `index.html` — публичный сайт (читает каталог из `/api/catalog`)
- `admin/index.html` — вход по паролю + редактирование товаров и настроек
- `img/` — фото товаров, `thumbs/` — миниатюры для сетки
- `worker.js` — Cloudflare Worker: отдаёт статику и API `/api/catalog` (запись/чтение Supabase)
- `wrangler.jsonc` — конфиг Worker'а (assets + модуль)
- `schema.sql`, `seed.sql` — схема и наполнение таблиц `products` и `settings` в Supabase
- `netlify/functions/catalog.js` — старая версия API для Netlify (запасной вариант)

## Адреса

- Сайт: https://detskyhit.detskyhit-site.workers.dev/
- Админка: https://detskyhit.detskyhit-site.workers.dev/admin/
- API: https://detskyhit.detskyhit-site.workers.dev/api/catalog
  (алиас `/.netlify/functions/catalog` тоже работает)

## Как обновить сайт

```cmd
cd "C:\Users\user\Documents\Проект по умолчанию\insta-catalog\detskyhit-site"
npx wrangler deploy
```

Перед деплоем закоммитьте изменения:

```cmd
git add -A && git commit -m "..." && git push origin main
```

## Переменные окружения (секреты Cloudflare Workers)

Задаются в Worker'е `detskyhit` (Settings → Variables and Secrets) или через CLI:

```cmd
npx wrangler secret put SUPABASE_URL --name detskyhit
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name detskyhit
npx wrangler secret put DETS_ADMIN_PASSWORD --name detskyhit
```

Пароль админки: `DETS_ADMIN_PASSWORD` (сейчас `Detskyhit2026@`). После смены секрета он действует сразу.

## Supabase

- Project URL: `https://pprsjobspvnktbnxeioe.supabase.co`
- Таблицы: `products`, `settings` (схема в `schema.sql`)

## Как работает админка

1. `/admin/` → вход по паролю (проверка пароля на сервере, POST `/api/catalog` с `{password}`).
2. Правите товары/настройки → «Сохранить товар» / «Сохранить всё» → данные пишутся в Supabase.
3. Сайт сам подхватывает новые данные без редеплоя.

## GitHub

Репозиторий: https://github.com/Vardenn/detskyhit-site (ветка `main`).

Для автодеплоя при пуше можно подключить Cloudflare Workers Builds:
dash.cloudflare.com → Workers & Pages → `detskyhit` → Settings → Builds → Connect to GitHub →
репозиторий `Vardenn/detskyhit-site`, ветка `main`, команда сборки пустая, команда деплоя `npx wrangler deploy`.
