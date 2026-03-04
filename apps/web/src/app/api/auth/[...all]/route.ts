import { NextResponse } from "next/server";

function disabled() {
	return NextResponse.json(
		{ error: "Authentication is disabled in local-storage mode" },
		{ status: 503 },
	);
}

export async function GET() {
	return disabled();
}

export async function POST() {
	return disabled();
}
