import { jest, mock } from "bun:test";
import { createDbMock } from "./db-mock";

/**
 * Installed via `bunfig.toml` preload, which is the bun equivalent of vitest's
 * `setupFiles`. Running before any test module loads is what makes this work:
 * `mock.module` is not hoisted, so calling it from inside a test file would be
 * too late for a database connection opened at import time.
 *
 * See ./db-mock.ts for why the mock exists at all.
 */
mock.module("@dokploy/server/db", () => createDbMock(jest.fn));
