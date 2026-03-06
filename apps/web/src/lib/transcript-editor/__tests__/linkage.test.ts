import { describe, expect, test } from "bun:test";
import {
	remapLinkedReferencesForClonedElement,
	remapTranscriptEditForClonedMedia,
} from "@/lib/transcript-editor/linkage";

describe("transcript linkage remapping", () => {
	test("remaps transcript word ids for cloned media and pins clip-local domain", () => {
		const remapped = remapTranscriptEditForClonedMedia({
			newMediaElementId: "media-copy",
			transcriptEdit: {
				version: 1,
				source: "word-level",
				words: [
					{
						id: "media-original:word:0:0.000",
						text: "hello",
						startTime: 0,
						endTime: 0.3,
					},
				],
				cuts: [{ start: 0.31, end: 0.5, reason: "manual" }],
				updatedAt: "2026-03-06T00:00:00.000Z",
				cutTimeDomain: "source-absolute",
			},
		});

		expect(remapped?.cutTimeDomain).toBe("clip-local-source");
		expect(remapped?.words[0]?.id.startsWith("media-copy:word:")).toBe(true);
	});

	test("remaps caption source ref when cloned linked media exists", () => {
		const cloned = remapLinkedReferencesForClonedElement({
			newElementId: "caption-copy",
			clonedIdMap: new Map([["media-original", "media-copy"]]),
			element: {
				id: "caption-original",
				type: "text",
				name: "Caption 1",
				content: "hello",
				startTime: 0,
				duration: 1,
				trimStart: 0,
				trimEnd: 0,
				fontSize: 16,
				fontFamily: "Arial",
				color: "#fff",
				background: { color: "transparent" },
				textAlign: "center",
				fontWeight: "normal",
				fontStyle: "normal",
				textDecoration: "none",
				transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
				opacity: 1,
				captionSourceRef: {
					mediaElementId: "media-original",
					transcriptVersion: 1,
				},
			},
		});

		if (cloned.type !== "text") throw new Error("Expected text");
		expect(cloned.captionSourceRef?.mediaElementId).toBe("media-copy");
	});
});
