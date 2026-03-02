import { NextResponse } from "next/server";

export async function GET() {
	return NextResponse.json(
		{
			error: "Sound search is disabled",
			message: "Freesound integration is disabled in this build.",
		},
		{ status: 410 },
	);
}
