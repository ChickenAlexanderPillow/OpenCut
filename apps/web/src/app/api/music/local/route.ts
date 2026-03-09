import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import {
	resolveMusicRoot,
	listLocalMusicFiles,
} from "@/lib/music/local-library";

const DEFAULT_DISPLAY_MUSIC_ROOT = "C:\\Users\\Design\\Music";

export async function GET(request: NextRequest) {
	try {
		const requestedRoot = request.nextUrl.searchParams.get("root")?.trim();
		const runtimeRoot = resolveMusicRoot({ rootOverride: requestedRoot });
		const displayRoot =
			requestedRoot && requestedRoot.length > 0
				? requestedRoot
				: DEFAULT_DISPLAY_MUSIC_ROOT;
		try {
			await access(runtimeRoot, fsConstants.R_OK);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
				await mkdir(runtimeRoot, { recursive: true });
			} else {
				throw error;
			}
		}
		const files = await listLocalMusicFiles({ rootOverride: runtimeRoot });
		return NextResponse.json({
			root: displayRoot,
			count: files.length,
			files,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to read local music folder";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
