# WellWeb Platform — Foundation

React + TypeScript + Vite and Supabase/PostgreSQL.

## Setup
1. Node.js 20.19+ or 22.12+ and npm.
2. `npm install`
3. `cp .env.example .env.local` and fill the Supabase project URL and publishable/anon key.
4. `npm run dev`

## Supabase migration
Install Supabase CLI, then verify the linked project is the intended **development** project before applying migrations:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Never put the `service_role` key in frontend environment variables. This is only the foundation scaffold; additional RLS policies and trusted provisioning functions are required before real users are enabled.
