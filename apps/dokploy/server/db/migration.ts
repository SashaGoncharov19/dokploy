import { dbUrl } from "@dokploy/server/db";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

const sql = new SQL(dbUrl, { max: 1 });
const db = drizzle(sql);

export const migration = async () =>
	await migrate(db, { migrationsFolder: "drizzle" })
		.then(() => {
			console.log("Migration complete");
			sql.end();
		})
		.catch((error) => {
			console.log("Migration failed", error);
		})
		.finally(() => {
			sql.end();
		});
