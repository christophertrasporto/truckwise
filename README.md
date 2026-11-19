# Truckwise

Internal trucking management system for Lalolu Trucking (dispatch, proof of delivery, billing). Built multi-tenant so partner operators can be added later. See `docs/PROGRESS.md` for status.

## Run locally

```bash
cp .env.example .env
docker compose up -d        # Postgres, MinIO, Mailpit   (no Docker? run `npm run db:embedded` in a separate terminal)
npm install
npm run db:migrate
npm run db:seed        # creates the owner from .env
npm run dev
```

## Test

```bash
npm test            # vitest; recreates the smartload_test database each run
npm run test:e2e    # Playwright; builds the app and uses its own smartload_e2e database
npm run typecheck
npm run lint
```

## First login

Set `OWNER_EMAIL`, `OWNER_NAME` and `OWNER_PASSWORD` in `.env`, then `npm run db:seed` creates the Lalolu Trucking company and its owner (it does nothing if that email already exists). Change the password after first login once password change exists (not built yet).

`npm run db:reset` wipes the local dev database. `npm run db:to-utf8` converts a Windows-created (WIN1252) dev database to UTF8 without losing data. `npm run db:seed-demo` loads sample companies and users (password `smartload-demo-1`) for experiments; the automated tests use that data in their own database.

Next.js 16 here uses Cache Components: pages that read cookies must render them inside `<Suspense>`.
