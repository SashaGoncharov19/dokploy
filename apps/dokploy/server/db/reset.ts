import { dbUrl } from "@dokploy/server/db";
// Credits to Louistiti from Drizzle Discord: https://discord.com/channels/1043890932593987624/1130802621750448160/1143083373535973406
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

const pg = new SQL(dbUrl, { max: 1 });
const db = drizzle(pg);

const clearDb = async (): Promise<void> => {
	try {
		const tablesQuery = sql<string>`DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP schema drizzle CASCADE;`;
		const tables = await db.execute(tablesQuery);
		console.log(tables);
		await pg.end();
	} catch (error) {
		console.error("Error cleaning database", error);
	} finally {
	}
};

clearDb();
