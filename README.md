# buildon-api

Servidor de datos de BuildOn (Cloudflare Worker: Hono + zod + supabase-js).
La app (repo `getbuildon/buildit`) le pide los datos con el token de la persona;
el Worker los lee de Supabase con ese token, así aplica la RLS por rol.

## Ambientes

| Ambiente | Worker | Base | App |
|---|---|---|---|
| local | `wrangler dev --env local` (puerto 8790) | test | http://localhost:3000 |
| test | `buildon-api-test` (workers.dev) | test | https://test.getbuildon.com |
| producción | `buildon-api` | producción | https://getbuildon.com |

## Uso

```bash
npm install
cp .dev.vars.example .dev.vars   # completar con las claves de la base de test
npm run dev
npm test
npm run typecheck
```

Secretos en Cloudflare: `wrangler secret put SUPABASE_URL --env test` (y `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).

`src/permisos.ts` es espejo de la matriz de permisos de la app (`lib/project/projectPermissions.ts`)
y de `has_project_permission()` en la base: si cambia una, cambian las tres.
