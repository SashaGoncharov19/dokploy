import { hashPassword } from "../lib/password";

export const generateRandomPassword = async () => {
	const passwordLength = 16;

	const characters =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

	let randomPassword = "";
	for (let i = 0; i < passwordLength; i++) {
		randomPassword += characters.charAt(
			Math.floor(Math.random() * characters.length),
		);
	}

	const hashedPassword = await hashPassword(randomPassword);
	return { randomPassword, hashedPassword };
};
