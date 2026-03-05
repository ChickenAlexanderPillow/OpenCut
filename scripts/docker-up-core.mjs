import { spawn } from "node:child_process";

const env = {
	...process.env,
	LOCAL_TRANSCRIBE_ENABLED: "false",
	LOCAL_TRANSCRIBE_FALLBACK_OPENAI: "false",
};

const child = spawn("docker", [
	"compose",
	"up",
	"-d",
	"--build",
	"redis",
	"serverless-redis-http",
	"web",
], {
	env,
	stdio: "inherit",
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});

