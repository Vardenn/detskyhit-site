# Detsky Hit — сайт

Статический сайт в стиле Instagram: каталог товаров, избранное, WhatsApp-кнопка, админка.

## Структура
- `index.html` — публичный сайт (читает `/.netlify/functions/catalog`)
- `admin/index.html` — вход по паролю + редактирование товаров и настроек
- `img/` — фото товаров
- `netlify/functions/catalog.js` — API (чтение/запись в Supabase)
- `schema.sql` — таблицы `products` и `settings` для Supabase

## Настройка (один раз)

### 1. Supabase
1. Зарегистрируйтесь на https://supabase.com → «New project» (бесплатно).
2. Запомните **Project URL** и **anon/service key**.
3. В SQL Editor вставьте и выполните `schema.sql`.
4. В Table editor проверьте, что появились таблицы `products` (36 строк) и `settings`.

### 2. GitHub
1. На github.com создайте пустой репозиторий (например, `detskyhit-site`).
2. В папке проекта выполните:
   ```
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<ваш-логин>/detskyhit-site.git
   git push -u origin main
   ```

### 3. Netlify
1. Project configuration → Environment variables — добавьте:
   - `SUPABASE_URL` = ваш Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = **service_role key** (секретный, НЕ anon key)
   - `DETS_ADMIN_PASSWORD` = новый пароль админки (по умолчанию detskyhit2026)
2. Build & deploy → Link repository → выберите `detskyhit-site` → Branch `main`.
3. Deploy. После этого каждый `git push` автоматически обновляет сайт.

## Как админка работает
- `detskyhit.netlify.app/admin/` → вход по паролю
- правите товары/настройки → «Сохранить» → изменения записываются в Supabase
- сайт сам подхватывает новые данные без редеплоя
