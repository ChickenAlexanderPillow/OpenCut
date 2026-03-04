import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TranscriptionSegment } from "@/types/transcription";
import type { ExternalSourceSystem } from "@/types/external-projects";
import { evaluateTranscriptSuitability } from "@/lib/external-projects/transcript-suitability";

interface StoredExternalProject {
	id: string;
	sourceSystem: ExternalSourceSystem;
	externalProjectId: string;
	name?: string;
	mode?: string;
	sponsored?: boolean;
	show?: string;
	sourceFilePath?: string;
	sourceAudioWavPath?: string;
	relativeKey?: string;
	createdAt: string;
	updatedAt: string;
}

interface StoredExternalProjectTranscript {
	id: string;
	projectId: string;
	transcriptText: string;
	segmentsJson: TranscriptionSegment[];
	segmentsCount: number;
	audioDurationSeconds: number | null;
	qualityMetaJson: Record<string, unknown>;
	updatedAt: string;
}

interface ExternalProjectsStore {
	projects: StoredExternalProject[];
	transcripts: StoredExternalProjectTranscript[];
}

const STORE_PATH = resolve(process.cwd(), ".opencut-data", "external-projects.json");
const DEFAULT_STORE: ExternalProjectsStore = {
	projects: [],
	transcripts: [],
};

let storeMutationQueue: Promise<void> = Promise.resolve();

function buildExternalTranscriptKey({
	sourceSystem,
	externalProjectId,
}: {
	sourceSystem: ExternalSourceSystem;
	externalProjectId: string;
}): string {
	return `${sourceSystem}:${externalProjectId}`;
}

async function readStore(): Promise<ExternalProjectsStore> {
	try {
		const raw = await readFile(STORE_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<ExternalProjectsStore>;
		return {
			projects: Array.isArray(parsed.projects)
				? (parsed.projects as StoredExternalProject[])
				: [],
			transcripts: Array.isArray(parsed.transcripts)
				? (parsed.transcripts as StoredExternalProjectTranscript[])
				: [],
		};
	} catch {
		return { ...DEFAULT_STORE };
	}
}

async function writeStore({ store }: { store: ExternalProjectsStore }): Promise<void> {
	await mkdir(dirname(STORE_PATH), { recursive: true });
	const tempPath = `${STORE_PATH}.tmp`;
	await writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
	await rename(tempPath, STORE_PATH);
}

async function mutateStore<T>({
	mutation,
}: {
	mutation: (store: ExternalProjectsStore) => Promise<T> | T;
}): Promise<T> {
	const run = async (): Promise<T> => {
		const store = await readStore();
		const result = await mutation(store);
		await writeStore({ store });
		return result;
	};

	const current = storeMutationQueue.then(run, run);
	storeMutationQueue = current.then(
		() => undefined,
		() => undefined,
	);
	return await current;
}

function withDates({ project }: { project: StoredExternalProject }) {
	return {
		...project,
		createdAt: new Date(project.createdAt),
		updatedAt: new Date(project.updatedAt),
	};
}

function withTranscriptDates({ transcript }: { transcript: StoredExternalProjectTranscript }) {
	return {
		...transcript,
		updatedAt: new Date(transcript.updatedAt),
	};
}

export function getDeepLinkForExternalProject({
	opencutProjectId,
	origin,
}: {
	opencutProjectId: string;
	origin: string;
}): string {
	const normalizedOrigin = origin.replace(/\/$/, "");
	return `${normalizedOrigin}/editor/${encodeURIComponent(opencutProjectId)}`;
}

export async function getExternalProjectByOpenCutId({
	projectId,
}: {
	projectId: string;
}) {
	const store = await readStore();
	const project = store.projects.find((candidate) => candidate.id === projectId);
	if (!project) return null;
	const transcript = store.transcripts.find(
		(candidate) => candidate.projectId === projectId,
	);
	return {
		project: withDates({ project }),
		transcript: transcript ? withTranscriptDates({ transcript }) : null,
	};
}

export async function getExternalProjectBySource({
	sourceSystem,
	externalProjectId,
}: {
	sourceSystem: ExternalSourceSystem;
	externalProjectId: string;
}) {
	const store = await readStore();
	const project = store.projects.find(
		(candidate) =>
			candidate.sourceSystem === sourceSystem &&
			candidate.externalProjectId === externalProjectId,
	);
	if (!project) return null;
	const transcript = store.transcripts.find(
		(candidate) => candidate.projectId === project.id,
	);
	return {
		project: withDates({ project }),
		transcript: transcript ? withTranscriptDates({ transcript }) : null,
	};
}

export async function upsertExternalProject({
	opencutProjectId,
	sourceSystem,
	externalProjectId,
	name,
	mode,
	sponsored,
	show,
	sourceFilePath,
	sourceAudioWavPath,
	relativeKey,
	transcript,
	segments,
	audioDurationSeconds,
}: {
	opencutProjectId: string;
	sourceSystem: ExternalSourceSystem;
	externalProjectId: string;
	name?: string;
	mode?: string;
	sponsored?: boolean;
	show?: string;
	sourceFilePath?: string;
	sourceAudioWavPath?: string;
	relativeKey?: string;
	transcript: string;
	segments: TranscriptionSegment[];
	audioDurationSeconds?: number | null;
}) {
	const now = new Date();
	const nowIso = now.toISOString();

	const suitability = evaluateTranscriptSuitability({
		transcriptText: transcript,
		segments,
		audioDurationSeconds: audioDurationSeconds ?? null,
	});

	const resolvedProjectId = await mutateStore({
		mutation: async (store) => {
			const existingByRelativeKey =
				relativeKey && relativeKey.length > 0
					? store.projects.find(
							(candidate) =>
								candidate.sourceSystem === sourceSystem &&
								candidate.relativeKey === relativeKey,
						)
					: undefined;
			const targetProjectId = existingByRelativeKey?.id ?? opencutProjectId;

			const existingBySource = store.projects.find(
				(candidate) =>
					candidate.sourceSystem === sourceSystem &&
					candidate.externalProjectId === externalProjectId,
			);

			const existing = existingByRelativeKey ?? existingBySource;
			if (existing) {
				existing.id = targetProjectId;
				existing.sourceSystem = sourceSystem;
				existing.externalProjectId = externalProjectId;
				existing.name = name;
				existing.mode = mode;
				existing.sponsored = sponsored;
				existing.show = show;
				existing.sourceFilePath = sourceFilePath;
				existing.sourceAudioWavPath = sourceAudioWavPath;
				existing.relativeKey = relativeKey;
				existing.updatedAt = nowIso;
			} else {
				store.projects.push({
					id: targetProjectId,
					sourceSystem,
					externalProjectId,
					name,
					mode,
					sponsored,
					show,
					sourceFilePath,
					sourceAudioWavPath,
					relativeKey,
					createdAt: nowIso,
					updatedAt: nowIso,
				});
			}

			const transcriptId = `${targetProjectId}:transcript`;
			const existingTranscript = store.transcripts.find(
				(candidate) => candidate.id === transcriptId,
			);
			const transcriptPayload: StoredExternalProjectTranscript = {
				id: transcriptId,
				projectId: targetProjectId,
				transcriptText: transcript,
				segmentsJson: segments,
				segmentsCount: segments.length,
				audioDurationSeconds:
					typeof audioDurationSeconds === "number"
						? Math.round(audioDurationSeconds)
						: null,
				qualityMetaJson: {
					...suitability,
				},
				updatedAt: nowIso,
			};

			if (existingTranscript) {
				Object.assign(existingTranscript, transcriptPayload);
			} else {
				store.transcripts.push(transcriptPayload);
			}

			return targetProjectId;
		},
	});

	return {
		opencutProjectId: resolvedProjectId,
		externalTranscriptCacheKey: buildExternalTranscriptKey({
			sourceSystem,
			externalProjectId,
		}),
		suitability,
	};
}
