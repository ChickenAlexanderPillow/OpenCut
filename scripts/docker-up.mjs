import { execFileSync, spawn } from "node:child_process";

const mode = process.argv[2] ?? "full";

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

function runCompose(services, envOverrides = {}) {
	const child = spawn(
		"docker",
		["compose", "up", "-d", "--build", ...services],
		{
			env: {
				...process.env,
				...envOverrides,
			},
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

function stopService(service) {
	try {
		execFileSync("docker", ["compose", "stop", service], {
			stdio: ["ignore", "ignore", "ignore"],
			timeout: 15_000,
		});
	} catch {
		// Ignore missing or already-stopped services.
	}
}

if (mode === "core" || mode === "web") {
	stopService("local-transcribe");
	runCompose(coreServices, coreEnv);
} else if (mode === "full") {
	if (process.env.LOCAL_TRANSCRIBE_ENABLED === "false") {
		stopService("local-transcribe");
		runCompose(coreServices, coreEnv);
	} else if (hasNvidiaGpu()) {
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
