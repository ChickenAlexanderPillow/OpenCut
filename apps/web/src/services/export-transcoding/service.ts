export async function transcodeTransparentOverlayExport({
	buffer,
	fileName,
}: {
	buffer: ArrayBuffer;
	fileName: string;
}): Promise<ArrayBuffer> {
	const formData = new FormData();
	formData.append(
		"file",
		new File([buffer], fileName, {
			type: "video/x-matroska",
		}),
	);

	const response = await fetch("/api/media/export-transparent-overlay", {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		let detail = "";
		try {
			const text = (await response.text()).trim();
			if (text) {
				try {
					const parsed = JSON.parse(text) as { error?: string };
					detail = parsed.error?.trim() ?? text;
				} catch {
					detail = text;
				}
			}
		} catch {}
		throw new Error(
			detail || `Transparent overlay transcode failed (${response.status})`,
		);
	}

	return await response.arrayBuffer();
}
