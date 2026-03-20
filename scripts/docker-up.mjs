import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const mode = process.argv[2] ?? "full";
const shouldBuild = process.argv.includes("--build");
const shouldBuildLocalTranscribeBase = process.argv.includes("--build-base");
const LOCAL_TRANSCRIBE_BASE_IMAGE = "opencut-local-transcribe-base:latest";

const coreServices = ["redis", "serverless-redis-http", "web"];
const fullServices = [...coreServices, "local-transcribe"];
const coreEnv = {
	LOCAL_TRANSCRIBE_ENABLED: "false",
	LOCAL_TRANSCRIBE_FALLBACK_OPENAI: "false",
};

function hasNvidiaGpu() {
	try {
		const output = execFileSync("nvidia-smi", ["-L"], {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		})
			.toString()
			.trim();
		return output.length > 0;
	} catch {
		return false;
	}
}

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

function buildComposeProcessEnv(envOverrides = {}) {
	const envFile = resolveComposeEnvFile();
	const fileEnv = envFile ? loadEnvFile(envFile) : {};
	return {
		...process.env,
		...fileEnv,
		...envOverrides,
	};
}

function runCompose(services, envOverrides = {}) {
	const envFile = resolveComposeEnvFile();
	if (!envFile) {
		console.error("apps/web/.env is required for Docker startup.");
		process.exit(1);
	}
	const composeArgs = ["compose"];
	composeArgs.push("up", "-d");
	if (shouldBuild) {
		composeArgs.push("--build");
	}
	composeArgs.push(...services);
	const child = spawn(
		"docker",
		composeArgs,
		{
			env: buildComposeProcessEnv(envOverrides),
			stdio: "inherit",
		},
	);

	child.on("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 1);
	});
}

function hasDockerImage(image) {
	try {
		execFileSync("docker", ["image", "inspect", image], {
			stdio: ["ignore", "ignore", "ignore"],
			timeout: 15_000,
		});
		return true;
	} catch {
		return false;
	}
}

function buildLocalTranscribeBaseImage({ forceRebuild = false } = {}) {
	if (!forceRebuild && hasDockerImage(LOCAL_TRANSCRIBE_BASE_IMAGE)) {
		return;
	}
	const buildArgs = [
		"build",
		"-f",
		"services/local-transcribe-whisperx/Dockerfile.base",
		"-t",
		LOCAL_TRANSCRIBE_BASE_IMAGE,
		"services/local-transcribe-whisperx",
	];
	if (forceRebuild) {
		buildArgs.splice(1, 0, "--pull");
	}
	execFileSync("docker", buildArgs, {
		env: buildComposeProcessEnv(),
		stdio: "inherit",
		timeout: 0,
	});
}

function stopService(service) {
	try {
		const envFile = resolveComposeEnvFile();
		const composeArgs = ["compose"];
		composeArgs.push("stop", service);
		execFileSync("docker", composeArgs, {
			env: buildComposeProcessEnv(),
			stdio: ["ignore", "ignore", "ignore"],
			timeout: 15_000,
		});
	} catch {
		// Ignore missing or already-stopped services.
	}
}

if (mode === "web") {
	runCompose(["web"]);
} else if (mode === "core") {
	stopService("local-transcribe");
	runCompose(coreServices, coreEnv);
} else if (mode === "full") {
	if (process.env.LOCAL_TRANSCRIBE_ENABLED === "false") {
		stopService("local-transcribe");
		runCompose(coreServices, coreEnv);
	} else if (hasNvidiaGpu()) {
		buildLocalTranscribeBaseImage({
			forceRebuild: shouldBuildLocalTranscribeBase,
		});
		runCompose(fullServices);
	} else {
		console.warn(
			"No NVIDIA GPU detected. Starting the web stack without local-transcribe.",
		);
		console.warn(
			"To force the full stack, install/configure NVIDIA container support and rerun `bun run docker:up`.",
		);
		stopService("local-transcribe");
		runCompose(coreServices, coreEnv);
	}
} else {
	console.error(`Unknown docker up mode: ${mode}`);
	process.exit(1);
}
