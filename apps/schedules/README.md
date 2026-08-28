# @dokploy/schedules

Scheduler. A [Hono](https://hono.dev) service that keeps the repeatable jobs — database
backups, volume backups, server cleanups and user-defined schedules — in
[BullMQ](https://bullmq.io) queues backed by Redis, and runs them when they come due.

**A self-hosted install does not run this.** Like `@dokploy/api`, it belongs to the
multi-tenant cloud build — `install.sh` never creates it, and with `IS_CLOUD` unset the
web app schedules its own jobs in-process. You only need it locally if you are working
on the cloud path.

## Running it

```bash
bun install          # from the repository root
bun run --filter @dokploy/schedules dev
```

The dev script sets `PORT=4001`. The code falls back to 3000 when `PORT` is unset, so
give it a value when you run the built output.

`GET /health` is open; every other route requires an `X-API-Key` header matching
`API_KEY`. It needs Redis, and the database connection that `@dokploy/server` provides.

Bun loads `.env` on its own — there is no `dotenv` import and none should be added.

## Building it

```bash
bun run --filter @dokploy/schedules build
bun run --filter @dokploy/schedules start
```

`bun build` emits a single self-contained file into `dist/`. It does not typecheck; run
that separately:

```bash
bun run --filter @dokploy/schedules typecheck
```
