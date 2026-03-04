import { NextResponse } from "next/server";
import { checkStorageHealth, isServerStorageEnabled } from "@/lib/server-storage/s3";

export async function GET() {
	const storageEnabled = isServerStorageEnabled();
	const storageHealthy = await checkStorageHealth();
	const ok = !storageEnabled || storageHealthy;

	return NextResponse.json(
		{
			ok,
			storage: {
				enabled: storageEnabled,
				healthy: storageHealthy,
			},
		},
		{ status: ok ? 200 : 503 },
	);
}
