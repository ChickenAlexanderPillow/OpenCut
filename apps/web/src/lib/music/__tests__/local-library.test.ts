import { afterEach, describe, expect, test } from "bun:test";
import { resolveMusicRoot } from "@/lib/music/local-library";

const ORIGINAL_RUNTIME_ROOT = process.env.OPENCUT_LOCAL_MUSIC_DIR;

describe("local music root resolution", () => {
	afterEach(() => {
		if (ORIGINAL_RUNTIME_ROOT === undefined) {
			delete process.env.OPENCUT_LOCAL_MUSIC_DIR;
			return;
		}
		process.env.OPENCUT_LOCAL_MUSIC_DIR = ORIGINAL_RUNTIME_ROOT;
	});

	test("maps the default Windows display root into the Docker runtime mount", () => {
		process.env.OPENCUT_LOCAL_MUSIC_DIR = "/host-music";

		expect(
			resolveMusicRoot({
				rootOverride: "C:\\Users\\Design\\Music\\Shorts",
			}),
		).toBe("/host-music/Shorts");
	});

	test("leaves non-default custom roots unchanged", () => {
		process.env.OPENCUT_LOCAL_MUSIC_DIR = "/host-music";

		expect(
			resolveMusicRoot({
				rootOverride: "D:\\Audio\\Library",
			}),
		).toBe("D:\\Audio\\Library");
	});
});
