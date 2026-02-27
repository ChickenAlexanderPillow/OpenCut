const LOCAL_FONTS_STORAGE_KEY = "opencut.local-fonts.v1";

type LocalFontRecord = {
	family: string;
	source: string;
	format: string;
	createdAt: string;
};

const loadedLocalFonts = new Set<string>();

function canUseFontApi(): boolean {
	return typeof window !== "undefined" && "FontFace" in window;
}

function inferFormatFromFile({ file }: { file: File }): string {
	const extension = file.name.split(".").pop()?.toLowerCase();
	if (extension === "woff2") return "woff2";
	if (extension === "woff") return "woff";
	if (extension === "otf") return "opentype";
	return "truetype";
}

function toSafeFamily({ input }: { input: string }): string {
	const base = input.replace(/\.[^/.]+$/, "").trim();
	const cleaned = base
		.replace(/\s+/g, " ")
		.replace(/[^\w\- ]/g, "")
		.trim();
	return cleaned.length > 0 ? cleaned : `Local Font ${Date.now()}`;
}

function readStoredFonts(): LocalFontRecord[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(LOCAL_FONTS_STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry) => {
			if (!entry || typeof entry !== "object") return false;
			const maybe = entry as Partial<LocalFontRecord>;
			return (
				typeof maybe.family === "string" &&
				typeof maybe.source === "string" &&
				typeof maybe.format === "string" &&
				typeof maybe.createdAt === "string"
			);
		}) as LocalFontRecord[];
	} catch {
		return [];
	}
}

function writeStoredFonts({ fonts }: { fonts: LocalFontRecord[] }): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(LOCAL_FONTS_STORAGE_KEY, JSON.stringify(fonts));
}

async function loadRecord({
	record,
}: {
	record: LocalFontRecord;
}): Promise<boolean> {
	if (!canUseFontApi()) return false;
	if (loadedLocalFonts.has(record.family)) return true;
	try {
		const fontFace = new FontFace(
			record.family,
			`url(${record.source}) format("${record.format}")`,
		);
		await fontFace.load();
		document.fonts.add(fontFace);
		loadedLocalFonts.add(record.family);
		return true;
	} catch {
		return false;
	}
}

function readFileAsDataUrl({ file }: { file: File }): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result === "string") {
				resolve(result);
				return;
			}
			reject(new Error("Failed to read local font file"));
		};
		reader.onerror = () =>
			reject(reader.error ?? new Error("Failed to read file"));
		reader.readAsDataURL(file);
	});
}

export function getLocalFontFamilies(): string[] {
	return readStoredFonts()
		.map((entry) => entry.family)
		.sort((a, b) => a.localeCompare(b));
}

export function hasLocalFont({ family }: { family: string }): boolean {
	return readStoredFonts().some((entry) => entry.family === family);
}

export async function ensureLocalFontsLoaded({
	families,
}: {
	families?: string[];
} = {}): Promise<void> {
	const records = readStoredFonts();
	if (records.length === 0) return;
	const familySet = families ? new Set(families) : null;
	const toLoad =
		familySet === null
			? records
			: records.filter((record) => familySet.has(record.family));
	await Promise.all(toLoad.map((record) => loadRecord({ record })));
}

export async function registerLocalFontFile({
	file,
}: {
	file: File;
}): Promise<string> {
	const family = toSafeFamily({ input: file.name });
	const source = await readFileAsDataUrl({ file });
	const format = inferFormatFromFile({ file });
	const nextRecord: LocalFontRecord = {
		family,
		source,
		format,
		createdAt: new Date().toISOString(),
	};
	const existing = readStoredFonts();
	const deduped = existing.filter((entry) => entry.family !== family);
	deduped.push(nextRecord);
	writeStoredFonts({ fonts: deduped });
	await loadRecord({ record: nextRecord });
	return family;
}
