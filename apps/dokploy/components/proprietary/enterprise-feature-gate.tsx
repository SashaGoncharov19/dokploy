"use client";

interface EnterpriseFeatureGateProps {
	children: React.ReactNode;
	/** Unused: kept so call sites do not have to change. */
	lockedProps?: {
		title?: string;
		description?: string;
		ctaLabel?: string;
		ctaHref?: string;
	};
	/** Unused: kept so call sites do not have to change. */
	fallback?: React.ReactNode;
}

/**
 * Renders its children.
 *
 * Licensing is removed in this fork, so there is nothing to gate. The component
 * stays as a pass-through rather than being deleted, because unwrapping it would
 * mean JSX surgery across five call sites for no behavioural gain.
 */
export function EnterpriseFeatureGate({
	children,
}: EnterpriseFeatureGateProps) {
	return <>{children}</>;
}
