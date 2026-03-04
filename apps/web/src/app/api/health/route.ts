import { NextResponse } from "next/server";

export async function GET() {
	return NextResponse.json({ ok: true, storage: { enabled: false, healthy: true } });
}
