#!/usr/bin/env node
import { execFileSync } from "node:child_process";

function runDockerVersionCheck() {
	try {
		const output = execFileSync(
			"docker",
			["version", "--format", "{{.Server.APIVersion}}"],
			{
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 15_000,
			},
		)
			.toString()
			.trim();
		if (!output) {
			throw new Error("Docker server API version not returned");
		}
		return output;
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown docker error";
		console.error(
			[
				"Docker engine is not healthy or not reachable.",
				"Fix this first, then run the OpenCut docker command again.",
				"",
				"Quick fixes:",
				"1) Restart Docker Desktop.",
				"2) Ensure Docker is in Linux containers mode.",
				"3) Run your terminal as Administrator and retry.",
				"",
				`Details: ${message}`,
			].join("\n"),
		);
		process.exit(1);
	}
}

const serverApiVersion = runDockerVersionCheck();
console.log(`Docker server API ready: ${serverApiVersion}`);
