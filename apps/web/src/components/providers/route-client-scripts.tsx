"use client";

import { usePathname } from "next/navigation";
import { BotIdClient } from "botid/client";
import { DatabuddyScript } from "./databuddy-script";

const protectedRoutes = [
	{
		path: "/none",
		method: "GET" as const,
	},
];

export function RouteClientScripts() {
	const pathname = usePathname();
	const isEditorRoute = pathname.startsWith("/editor/");
	const shouldLoadThirdPartyScripts =
		process.env.NODE_ENV === "production" && !isEditorRoute;

	if (!shouldLoadThirdPartyScripts) {
		return null;
	}

	return (
		<>
			<BotIdClient protect={protectedRoutes} />
			<DatabuddyScript />
		</>
	);
}
