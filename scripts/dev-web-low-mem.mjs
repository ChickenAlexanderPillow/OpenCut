import { spawn } from "node:child_process";
import { resolve } from "node:path";
const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
const maxOldSpace = "--max-old-space-size=2048";

const env = {
	...process.env,
	NODE_OPTIONS: existingNodeOptions
		? `${existingNodeOptions} ${maxOldSpace}`
		: maxOldSpace,
};

const child = spawn("bun run dev", [], {
	cwd: resolve(process.cwd(), "apps/web"),
	env,
	shell: true,
	stdio: "inherit",
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
