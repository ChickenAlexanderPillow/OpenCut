import { NextResponse, type NextRequest } from "next/server";
import {
	PREMIERE_ALPHA_EXPORT_MIME_TYPE,
	transcodeTransparentOverlayToPremiereMov,
} from "@/lib/export-transparent-overlay";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
	try {
		const contentType = request.headers.get("content-type") ?? "";
		if (!contentType.includes("multipart/form-data")) {
			return NextResponse.json(
				{ error: "Expected multipart/form-data request body" },
				{ status: 400 },
			);
		}

		const formData = await request.formData();
		const fileEntry = formData.get("file");
		if (!(fileEntry instanceof File)) {
			return NextResponse.json({ error: "file is required" }, { status: 400 });
		}

		const result = await transcodeTransparentOverlayToPremiereMov({
			inputBuffer: await fileEntry.arrayBuffer(),
			fileName: fileEntry.name || "captions-overlay.mkv",
		});

		return new NextResponse(result.buffer, {
			status: 200,
			headers: {
				"content-type": PREMIERE_ALPHA_EXPORT_MIME_TYPE,
				"x-output-filename": result.fileName,
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unexpected export transcode error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
