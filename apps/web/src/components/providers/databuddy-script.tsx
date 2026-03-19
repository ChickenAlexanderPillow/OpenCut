"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

export function DatabuddyScript() {
	const pathname = usePathname();
	const isEditorRoute = pathname.startsWith("/editor/");
	const shouldLoadAnalytics =
		process.env.NODE_ENV === "production" && !isEditorRoute;

	if (!shouldLoadAnalytics) {
		return null;
	}

	return (
		<Script
			src="https://cdn.databuddy.cc/databuddy.js"
			strategy="afterInteractive"
			async
			data-client-id="UP-Wcoy5arxFeK7oyjMMZ"
			data-disabled={false}
			data-track-attributes={false}
			data-track-errors={true}
			data-track-outgoing-links={false}
			data-track-web-vitals={false}
			data-track-sessions={false}
		/>
	);
}
