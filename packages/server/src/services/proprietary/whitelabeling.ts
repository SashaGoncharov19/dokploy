import { IS_CLOUD } from "@dokploy/server/constants";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";

export interface PublicWhitelabelingConfig {
	appName: string | null;
	appDescription: string | null;
	logoUrl: string | null;
	loginLogoUrl: string | null;
	faviconUrl: string | null;
	customCss: string | null;
	metaTitle: string | null;
	errorPageTitle: string | null;
	errorPageDescription: string | null;
	footerText: string | null;
}

/**
 * Branding this fork ships with, so a fresh install identifies itself as the Bun
 * build without anyone configuring whitelabeling first.
 *
 * Only the fields the interface actually renders are set. appName is deliberately
 * left null: nothing outside the whitelabeling settings screen reads it, so
 * setting it would suggest an effect it does not have.
 *
 * Anything an administrator saves overrides these, field by field.
 */
export const DEFAULT_WHITELABELING = {
	appName: null,
	appDescription: "Dokploy running on Bun",
	logoUrl: null,
	loginLogoUrl: null,
	faviconUrl: null,
	customCss: null,
	metaTitle: "Dokploy Bun",
	errorPageTitle: null,
	errorPageDescription: null,
	footerText: "Dokploy Bun",
} satisfies PublicWhitelabelingConfig;

/**
 * Stored config wins field by field; unset fields fall back to this fork's
 * defaults. A stored empty string counts as unset - the settings form writes ""
 * for a cleared input, and treating that as "no logo, no title" is what the
 * administrator meant.
 */
export const withDefaultWhitelabeling = <
	T extends Partial<PublicWhitelabelingConfig>,
>(
	config: T | null | undefined,
): T & PublicWhitelabelingConfig => {
	// Generic so fields outside PublicWhitelabelingConfig - supportUrl, docsUrl -
	// survive the merge instead of being narrowed away.
	const merged = {
		...DEFAULT_WHITELABELING,
		...(config ?? {}),
	} as T & PublicWhitelabelingConfig;

	for (const key of Object.keys(
		DEFAULT_WHITELABELING,
	) as (keyof PublicWhitelabelingConfig)[]) {
		const value = config?.[key];
		if (value === undefined || value === null || value === "") {
			merged[key] = DEFAULT_WHITELABELING[key];
		}
	}
	return merged;
};

/**
 * Public whitelabeling config for unauthenticated contexts (login page, SSR
 * document shell). No active organization/session is available here.
 */
export const getPublicWhitelabelingConfig =
	async (): Promise<PublicWhitelabelingConfig | null> => {
		if (IS_CLOUD) {
			return null;
		}
		const settings = await getWebServerSettings();
		return withDefaultWhitelabeling(settings?.whitelabelingConfig);
	};
