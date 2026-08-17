import { dbUrl } from "@dokploy/server/db/constants";
import * as schema from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";

export { and, eq };

type Database = BunSQLDatabase<typeof schema>;
/**
 * Evita problemas de redeclaración global en monorepos.
 * No usamos `declare global`.
 */
const globalForDb = globalThis as unknown as {
	db?: Database;
};

let dbConnection: Database;

if (process.env.NODE_ENV === "production") {
	// En producción no usamos global cache
	dbConnection = drizzle(dbUrl, {
		schema,
	});
} else {
	// En desarrollo reutilizamos conexión para evitar múltiples conexiones
	if (!globalForDb.db) {
		globalForDb.db = drizzle(dbUrl, {
			schema,
		});
	}

	dbConnection = globalForDb.db;
}

export const db: Database = dbConnection;

export { dbUrl };
