import { readdir, stat } from "node:fs/promises";
import { extname, posix, relative, resolve, sep, win32 } from "node:path";

const DEFAULT_LOCAL_MUSIC_ROOT = "C:\\Users\\Design\\Music";

const AUDIO_EXTENSIONS = new Set([
	".mp3",
	".wav",
	".m4a",
	".aac",
	".ogg",
	".flac",
	".opus",
	".wma",
	".aif",
	".aiff",
]);

export type LocalMusicEntry = {
	name: string;
	relativePath: string;
	directory: string;
	extension: string;
	sizeBytes: number;
	modifiedAt: string;
};

export function getLocalMusicRoot(): string {
	const envRoot = process.env.OPENCUT_LOCAL_MUSIC_DIR?.trim();
	return envRoot && envRoot.length > 0 ? envRoot : DEFAULT_LOCAL_MUSIC_ROOT;
}

function normalizeWindowsPath(value: string): string {
	return value.replace(/\//g, "\\");
}

function isWindowsPathInsideRoot({
	root,
	target,
}: {
	root: string;
	target: string;
}): boolean {
	const normalizedRoot = normalizeWindowsPath(root).replace(/[\\\/]+$/, "");
	const normalizedTarget = normalizeWindowsPath(target);
	const rootLower = normalizedRoot.toLowerCase();
	const targetLower = normalizedTarget.toLowerCase();
	return (
		targetLower === rootLower ||
		targetLower.startsWith(`${rootLower}\\`)
	);
}

function translateDisplayRootToRuntime({
	rootOverride,
}: {
	rootOverride?: string;
}): string | undefined {
	const trimmed = rootOverride?.trim();
	const runtimeRoot = process.env.OPENCUT_LOCAL_MUSIC_DIR?.trim();
	if (!trimmed || !runtimeRoot || runtimeRoot === DEFAULT_LOCAL_MUSIC_ROOT) {
		return trimmed;
	}
	if (!runtimeRoot.startsWith("/")) {
		return trimmed;
	}
	if (!isWindowsPathInsideRoot({ root: DEFAULT_LOCAL_MUSIC_ROOT, target: trimmed })) {
		return trimmed;
	}

	const relativeSuffix = win32.relative(
		DEFAULT_LOCAL_MUSIC_ROOT,
		normalizeWindowsPath(trimmed),
	);
	if (!relativeSuffix || relativeSuffix === "") {
		return runtimeRoot;
	}
	return posix.join(runtimeRoot, ...relativeSuffix.split(/[\\/]+/));
}

export function resolveMusicRoot({
	rootOverride,
}: {
	rootOverride?: string;
}): string {
	const translatedRoot = translateDisplayRootToRuntime({ rootOverride });
	return translatedRoot && translatedRoot.length > 0
		? translatedRoot
		: getLocalMusicRoot();
}

function toPosixPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function isPathInsideRoot({
	root,
	target,
}: {
	root: string;
	target: string;
}): boolean {
	const normalizedRoot = resolve(root);
	const normalizedTarget = resolve(target);
	return (
		normalizedTarget === normalizedRoot ||
		normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
	);
}

export function resolveLocalMusicPath({
	relativePath,
	rootOverride,
}: {
	relativePath: string;
	rootOverride?: string;
}): string {
	const root = resolveMusicRoot({ rootOverride });
	const normalizedRelative = relativePath.replace(/\//g, sep);
	const candidate = resolve(root, normalizedRelative);
	if (!isPathInsideRoot({ root, target: candidate })) {
		throw new Error("Invalid music path");
	}
	return candidate;
}

export async function listLocalMusicFiles({
	rootOverride,
}: {
	rootOverride?: string;
} = {}): Promise<LocalMusicEntry[]> {
	const root = resolveMusicRoot({ rootOverride });
	const files: LocalMusicEntry[] = [];
	const pendingDirs = [root];

	while (pendingDirs.length > 0) {
		const currentDir = pendingDirs.pop();
		if (!currentDir) continue;
		const entries = await readdir(currentDir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = resolve(currentDir, entry.name);
			if (entry.isDirectory()) {
				pendingDirs.push(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;

			const extension = extname(entry.name).toLowerCase();
			if (!AUDIO_EXTENSIONS.has(extension)) continue;

			const metadata = await stat(fullPath);
			const relativePath = toPosixPath(relative(root, fullPath));
			const directory = relativePath.includes("/")
				? relativePath.slice(0, relativePath.lastIndexOf("/"))
				: "";

			files.push({
				name: entry.name,
				relativePath,
				directory,
				extension: extension.slice(1),
				sizeBytes: metadata.size,
				modifiedAt: metadata.mtime.toISOString(),
			});
		}
	}

	return files.sort((a, b) =>
		a.relativePath.localeCompare(b.relativePath, undefined, {
			sensitivity: "base",
			numeric: true,
		}),
	);
}

export function isSupportedMusicExtension({
	fileName,
}: {
	fileName: string;
}): boolean {
	return AUDIO_EXTENSIONS.has(extname(fileName).toLowerCase());
}
