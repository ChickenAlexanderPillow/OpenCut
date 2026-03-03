import type { MigrationResult, ProjectRecord } from "./types";
import { getProjectId } from "./utils";

export function transformProjectV7ToV8({
	project,
}: {
	project: ProjectRecord;
}): MigrationResult<ProjectRecord> {
	const projectId = getProjectId({ project });
	if (!projectId) {
		return { project, skipped: true, reason: "no project id" };
	}

	if (isV8Project({ project })) {
		return { project, skipped: true, reason: "already v8" };
	}

	// One-time reset of transcript-derived caches to clear stale data.
	return {
		project: {
			...project,
			version: 8,
			transcriptionCache: {},
			clipTranscriptCache: {},
			clipWordTranscriptionCache: {},
			externalTranscriptCache: {},
		},
		skipped: false,
	};
}

function isV8Project({ project }: { project: ProjectRecord }): boolean {
	return typeof project.version === "number" && project.version >= 8;
}
