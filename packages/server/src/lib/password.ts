/// <reference types="bun" />

/**
 * Password hashing on Bun's native `Bun.password`, replacing the `bcrypt` native
 * module.
 *
 * Two things this module exists to guarantee:
 *
 * 1. **The algorithm is always bcrypt.** `Bun.password.hash` defaults to argon2id.
 *    The `user`/`account` tables hold `$2b$` bcrypt hashes and
 *    `utils/traefik/security.ts` writes an htpasswd file Traefik parses as bcrypt,
 *    so defaulting would break logins and basic auth - and unlike most mistakes
 *    here, it is a one-way door once hashes are written.
 *
 * 2. **Verification never throws.** npm `bcrypt` returns `false` for a malformed,
 *    truncated, empty or wrong-algorithm hash; `Bun.password.verify*` throws for
 *    all of those except the empty string. Without normalising, one corrupted row
 *    in `account.password` turns a clean "wrong password" response into a 500.
 *
 * Hash compatibility with npm bcrypt was verified in both directions - existing
 * `$2b$` hashes verify here, and hashes written here verify under npm bcrypt, so
 * no password migration is needed and a rollback strands nobody.
 * See docs/bun-migration/SPIKE-RESULTS.md.
 */

const DEFAULT_COST = 10;

export const hashPassword = (password: string, cost: number = DEFAULT_COST) =>
	Bun.password.hash(password, { algorithm: "bcrypt", cost });

export const hashPasswordSync = (
	password: string,
	cost: number = DEFAULT_COST,
) => Bun.password.hashSync(password, { algorithm: "bcrypt", cost });

export const verifyPasswordSync = (password: string, hash: string): boolean => {
	try {
		return Bun.password.verifySync(password, hash);
	} catch {
		// Malformed or unrecognised hash - matches npm bcrypt, which returns false
		// rather than throwing.
		return false;
	}
};

export const verifyPassword = async (
	password: string,
	hash: string,
): Promise<boolean> => {
	try {
		return await Bun.password.verify(password, hash);
	} catch {
		return false;
	}
};
