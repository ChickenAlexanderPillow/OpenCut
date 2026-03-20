import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
const shouldBuild = process.argv.includes("--build");

const env = {
	...process.env,
	LOCAL_TRANSCRIBE_ENABLED: "false",
	LOCAL_TRANSCRIBE_FALLBACK_OPENAI: "false",
};

function resolveComposeEnvFile() {
	return existsSync("apps/web/.env") ? "apps/web/.env" : null;
}

function loadEnvFile(filePath) {
	const parsed = {};
	const content = readFileSync(filePath, "utf8");
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separatorIndex = line.indexOf("=");
		if (separatorIndex <= 0) continue;
		const key = line.slice(0, separatorIndex).trim();
		if (!key) continue;
		let value = line.slice(separatorIndex + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		parsed[key] = value;
	}
	return parsed;
}

function buildComposeProcessEnv() {
	const envFile = resolveComposeEnvFile();
	const fileEnv = envFile ? loadEnvFile(envFile) : {};
	return {
		...process.env,
		...fileEnv,
		...env,
	};
}

const composeArgs = ["compose"];
const envFile = resolveComposeEnvFile();
if (!envFile) {
	console.error("apps/web/.env is required for Docker startup.");
	process.exit(1);
}
composeArgs.push("up", "-d");
if (shouldBuild) {
	composeArgs.push("--build");
}
composeArgs.push("redis", "serverless-redis-http", "web");

const child = spawn("docker", composeArgs, {
	env: buildComposeProcessEnv(),
	stdio: "inherit",
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
