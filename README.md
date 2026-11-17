# WellWeb Platform

React, TypeScript, Vite and Supabase Auth/PostgreSQL. The first MVP delivery contains HOTEL and PROFESSIONAL registration, login, password recovery and private profile areas.

## Local setup

Requirements: Node.js 20.19+ (or 22.12+), npm and Docker Desktop/the Docker daemon for Supabase local development.

```bash
npm install
npx supabase start
```

Copy the **local** API URL and anon/publishable key shown by `npx supabase status` into `.env.local` using `.env.example` as a template. Do not put a `service_role` key in a `VITE_` variable. Vite development mode intentionally blocks hosted Supabase URLs; local signup must never target production.

For a separately reviewed hosted deployment, set `VITE_SUPABASE_ENV=production` in that deployment's build environment and allow the `/entrar` and `/nova-palavra-passe` callback URLs in Supabase Auth. This opt-in is not set in local development.

### Database baseline prerequisite

Production has the first four migration versions recorded. The current checked-in version of `202611020001_initial_identity.sql` includes objects that migration `202611030001_identity_integrity_security.sql` creates again, so replaying the current migration directory against an empty database fails before it reaches the MVP migration. The baseline reconciliation discussed for this repository has not yet been implemented. Do not push migrations or use production credentials to work around this. Complete and review the separate forward-only baseline plan before expecting `supabase db reset` to work from an empty database.

Once the active migration history has been reconciled in a reviewed DEV workflow, a clean local reset should replay the migrations and seed (if configured):

```bash
npx supabase db reset
```

Then start the app on the redirect URL configured by the local Supabase project:

```bash
npm run dev -- --host 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000`. Create HOTEL and PROFESSIONAL accounts separately, confirm email through the local Supabase email inbox (Inbucket), and sign in. The local Supabase stack and the reconciled migrations are prerequisites for demonstrating database-backed auth. No production database is needed or used.

## Checks

```bash
npm test
npm run build
```

Tests cover registration validation, role metadata and private route access. They do not replace integration tests against a local Supabase database.
