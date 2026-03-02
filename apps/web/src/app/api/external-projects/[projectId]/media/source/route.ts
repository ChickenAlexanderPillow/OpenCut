import { access } from "node:fs/promises";
import { constants as fsConstants, createReadStream, ReadStream } from "node:fs";
import { basename } from "node:path";
import { NextResponse } from "next/server";
import { getExternalProjectByOpenCutId } from "@/lib/external-projects/service";

function getMimeTypeFromFilename(filename: string): string {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".mp4")) return "video/mp4";
	if (lower.endsWith(".mov")) return "video/quicktime";
	if (lower.endsWith(".mkv")) return "video/x-matroska";
	if (lower.endsWith(".webm")) return "video/webm";
	if (lower.endsWith(".mp3")) return "audio/mpeg";
	if (lower.endsWith(".wav")) return "audio/wav";
	if (lower.endsWith(".m4a")) return "audio/mp4";
	return "application/octet-stream";
}

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	try {
		const { projectId } = await params;
		const linked = await getExternalProjectByOpenCutId({ projectId });
		if (!linked?.project?.sourceFilePath) {
			return NextResponse.json(
				{ error: "Linked source media path not found" },
				{ status: 404 },
			);
		}

		const filePath = linked.project.sourceFilePath;
		await access(filePath, fsConstants.R_OK);
		const fileName = basename(filePath);
		const mimeType = getMimeTypeFromFilename(fileName);
		const nodeStream = createReadStream(filePath);
		const webStream = ReadStream.toWeb(nodeStream) as unknown as ReadableStream;

		return new NextResponse(webStream, {
			headers: {
				"Content-Type": mimeType,
				"Content-Disposition": `inline; filename=\"${fileName}\"`,
				"Cache-Control": "no-store",
				"X-Source-Media-Name": fileName,
			},
		});
	} catch (error) {
		console.error("Failed to stream linked source media", error);
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : "Failed to stream media",
			},
			{ status: 500 },
		);
	}
}
