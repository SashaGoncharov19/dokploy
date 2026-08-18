"use client";

import { Loader2, Lock } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

interface EnterpriseFeatureLockedProps {
	/** Optional title override */
	title?: string;
	/** Optional description override */
	description?: string;
	/** Optional custom CTA label */
	ctaLabel?: string;
	/** Optional CTA href (default: /dashboard/settings/license) */
	ctaHref?: string;
	/** Compact variant (less padding, smaller icon) */
	compact?: boolean;
}

/**
 * Displays a locked state for enterprise features when the user has no valid license.
 * Use standalone or via EnterpriseFeatureGate.
 */
export function EnterpriseFeatureLocked({
	title = "Enterprise feature",
	description = "This feature is part of Dokploy Enterprise. Add a valid license to use it.",
	ctaLabel = "Go to License",
	ctaHref = "/dashboard/settings/license",
	compact = false,
}: EnterpriseFeatureLockedProps) {
	return (
		<Card className="border-dashed bg-transparent">
			<CardHeader className={compact ? "pb-2" : undefined}>
				<div className="flex flex-col items-center gap-3 text-center">
					<div
						className={
							compact
								? "rounded-full bg-muted p-3"
								: "rounded-full bg-muted p-4"
						}
					>
						<Lock
							className={
								compact
									? "size-6 text-muted-foreground"
									: "size-8 text-muted-foreground"
							}
						/>
					</div>
					<div className="space-y-1">
						<CardTitle className="text-lg">{title}</CardTitle>
						<CardDescription className="max-w-sm mx-auto">
							{description}
						</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent className={compact ? "pt-0" : undefined}>
				<div className="flex justify-center">
					<Button asChild variant="secondary" size={compact ? "sm" : "default"}>
						<Link href={ctaHref}>{ctaLabel}</Link>
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

interface EnterpriseFeatureGateProps {
	children: React.ReactNode;
	/** Unused: kept so call sites do not have to change. */
	lockedProps?: Omit<EnterpriseFeatureLockedProps, "compact">;
	/** Unused: kept so call sites do not have to change. */
	fallback?: React.ReactNode;
}

/**
 * Renders its children.
 *
 * Licensing is removed in this fork, so there is nothing to gate. The component
 * stays as a pass-through rather than being deleted, because unwrapping it would
 * mean JSX surgery across five call sites for no behavioural gain.
 * EnterpriseFeatureLocked above is still exported: add-permissions.tsx references
 * it from a branch that is now unreachable.
 */
export function EnterpriseFeatureGate({
	children,
}: EnterpriseFeatureGateProps) {
	return <>{children}</>;
}
