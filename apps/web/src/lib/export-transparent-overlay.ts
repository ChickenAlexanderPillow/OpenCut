import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const PREMIERE_ALPHA_EXPORT_MIME_TYPE = "video/quicktime";

async function runFfmpeg({
	args,
}: {
	args: string[];
}): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("ffmpeg", args, {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			reject(error);
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					stderr.trim() || `ffmpeg exited with non-zero status ${code ?? -1}`,
				),
			);
		});
	});
}

function getSafeBaseName({ fileName }: { fileName: string }): string {
	const stripped = fileName.replace(/\.[^.]+$/, "");
	const safe = stripped.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").trim();
	return safe.length > 0 ? safe : "captions-overlay";
}

export async function transcodeTransparentOverlayToPremiereMov({
	inputBuffer,
	fileName,
}: {
	inputBuffer: ArrayBuffer;
	fileName: string;
}): Promise<{
	buffer: ArrayBuffer;
	fileName: string;
	mimeType: typeof PREMIERE_ALPHA_EXPORT_MIME_TYPE;
}> {
	const safeBaseName = getSafeBaseName({ fileName });
	const workingDirectory = await mkdtemp(
		path.join(tmpdir(), "opencut-alpha-export-"),
	);
	const inputPath = path.join(workingDirectory, `${safeBaseName}.mkv`);
	const outputPath = path.join(workingDirectory, `${safeBaseName}.mov`);

	try {
		await writeFile(inputPath, Buffer.from(inputBuffer));

		await runFfmpeg({
			args: [
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-c:v",
				"libvpx-vp9",
				"-i",
				inputPath,
				"-map",
				"0:v:0",
				"-map",
				"0:a:0?",
				"-c:v",
				"prores_ks",
				"-profile:v",
				"4",
				"-pix_fmt",
				"yuva444p10le",
				"-alpha_bits",
				"16",
				"-vendor",
				"apl0",
				"-movflags",
				"+faststart",
				"-c:a",
				"pcm_s16le",
				"-ar",
				"48000",
				"-ac",
				"2",
				outputPath,
			],
		});

		const output = await readFile(outputPath);
		return {
			buffer: Uint8Array.from(output).buffer,
			fileName: `${safeBaseName}.mov`,
			mimeType: PREMIERE_ALPHA_EXPORT_MIME_TYPE,
		};
	} finally {
		await rm(workingDirectory, { recursive: true, force: true });
	}
}
