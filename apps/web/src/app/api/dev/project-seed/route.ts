import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

type BrowserPastePayload = {
	projectId: string;
	project: unknown;
};

async function resolveBrowserPastePath(): Promise<string | null> {
	const cwd = process.cwd();
	const candidates = [
		resolve(cwd, "docs", "browser-paste.json"),
		resolve(cwd, "..", "docs", "browser-paste.json"),
		resolve(cwd, "..", "..", "docs", "browser-paste.json"),
	];
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			continue;
		}
	}
	return null;
}

export async function GET() {
	try {
		const browserPastePath = await resolveBrowserPastePath();
		if (!browserPastePath) {
			return NextResponse.json(
				{
					error:
						"Could not locate docs/browser-paste.json from current runtime cwd",
				},
				{ status: 404 },
			);
		}
		const raw = await readFile(browserPastePath, "utf8");
		const parsed = JSON.parse(raw) as Partial<BrowserPastePayload>;
		if (
			typeof parsed.projectId !== "string" ||
			parsed.projectId.length === 0 ||
			typeof parsed.project !== "object" ||
			parsed.project === null
		) {
			return NextResponse.json(
				{ error: "Invalid docs/browser-paste.json payload" },
				{ status: 400 },
			);
		}

		return NextResponse.json({
			projectId: parsed.projectId,
			project: parsed.project,
		});
	} catch (error) {
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to read docs/browser-paste.json",
			},
			{ status: 500 },
		);
	}
}
