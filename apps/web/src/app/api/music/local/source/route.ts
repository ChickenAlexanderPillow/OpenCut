import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import {
	isSupportedMusicExtension,
	resolveLocalMusicPath,
} from "@/lib/music/local-library";

const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	aac: "audio/aac",
	ogg: "audio/ogg",
	flac: "audio/flac",
	opus: "audio/opus",
	wma: "audio/x-ms-wma",
	aif: "audio/aiff",
	aiff: "audio/aiff",
};

function contentTypeFromFileName({ fileName }: { fileName: string }): string {
	const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
	return CONTENT_TYPES_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export async function GET(request: NextRequest) {
	try {
		const relativePath = request.nextUrl.searchParams.get("path")?.trim();
		const requestedRoot = request.nextUrl.searchParams.get("root") ?? undefined;
		if (!relativePath) {
			return NextResponse.json(
				{ error: "Missing path query parameter" },
				{ status: 400 },
			);
		}

		if (!isSupportedMusicExtension({ fileName: relativePath })) {
			return NextResponse.json(
				{ error: "Unsupported audio extension" },
				{ status: 400 },
			);
		}

		const absolutePath = resolveLocalMusicPath({
			relativePath,
			rootOverride: requestedRoot,
		});
		const fileName = basename(absolutePath);
		const fileBuffer = await readFile(absolutePath);
		return new NextResponse(fileBuffer, {
			status: 200,
			headers: {
				"content-type": contentTypeFromFileName({ fileName }),
				"x-file-name": encodeURIComponent(fileName),
			},
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to read local music file";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
