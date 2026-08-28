# @dokploy/api

Deployment worker. A [Hono](https://hono.dev) service that receives deploy jobs over
[Inngest](https://www.inngest.com) and runs them, with concurrency limited to one
deployment per server so two builds never contend for the same host.

**A self-hosted install does not run this.** `install.sh` creates two services,
`dokploy-postgres` and `dokploy`, and neither is this one. With `IS_CLOUD` unset the web
app builds an in-process queue (`server/queues/queueSetup.ts`) and runs the worker
itself; with `IS_CLOUD=true` it installs a no-op queue instead and deployments come
here. So this service exists for the multi-tenant cloud build, and you only need it
locally if that is what you are working on.

## Running it

```bash
bun install          # from the repository root
bun run --filter @dokploy/api dev
```

The dev script sets `PORT=4000`. The code falls back to 3000 when `PORT` is unset, so
give it a value when you run the built output.

`GET /health` and `/api/inngest` are open — the first so orchestrators can probe it, the
second because Inngest authenticates itself. Every other route requires an `X-API-Key`
header matching `API_KEY`.

Bun loads `.env` on its own — there is no `dotenv` import and none should be added.

## Building it

```bash
bun run --filter @dokploy/api build
bun run --filter @dokploy/api start
```

`bun build` emits a single self-contained file into `dist/`, which is why the image for
this service ships no `node_modules` at all and weighs 234MB instead of 1.25GB.

It does not typecheck. Run that separately:

```bash
bun run --filter @dokploy/api typecheck
```
