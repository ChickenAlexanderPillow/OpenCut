import { z } from "zod";

const webEnvSchema = z.object({
	// Node
	NODE_ENV: z.enum(["development", "production", "test"]),
	ANALYZE: z.string().optional(),
	NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional(),

	// Public
	NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
	NEXT_PUBLIC_MARBLE_API_URL: z.url(),

	// Server
	BETTER_AUTH_SECRET: z.string(),
	UPSTASH_REDIS_REST_URL: z.url(),
	UPSTASH_REDIS_REST_TOKEN: z.string(),
	MARBLE_WORKSPACE_KEY: z.string(),
	FREESOUND_CLIENT_ID: z.string().optional(),
	FREESOUND_API_KEY: z.string().optional(),
	CLOUDFLARE_ACCOUNT_ID: z.string(),
	R2_ACCESS_KEY_ID: z.string(),
	R2_SECRET_ACCESS_KEY: z.string(),
	R2_BUCKET_NAME: z.string(),
	MODAL_TRANSCRIPTION_URL: z.url(),
	OPENAI_API_KEY: z.string().optional(),
	LOCAL_TRANSCRIBE_ENABLED: z
		.string()
		.optional()
		.transform((value) => (value ?? "true").toLowerCase() === "true"),
	LOCAL_TRANSCRIBE_URL: z.url().optional(),
	LOCAL_TRANSCRIBE_TIMEOUT_MS: z
		.string()
		.optional()
		.transform((value) => {
			if (!value) return 120000;
			const parsed = Number.parseInt(value, 10);
			return Number.isFinite(parsed) && parsed > 0 ? parsed : 120000;
		}),
	LOCAL_TRANSCRIBE_API_KEY: z.string().optional(),
	LOCAL_TRANSCRIBE_MODEL: z.string().optional(),
	LOCAL_TRANSCRIBE_COMPUTE_TYPE: z.string().optional(),
	LOCAL_TRANSCRIBE_DEVICE: z.string().optional(),
	LOCAL_TRANSCRIBE_FALLBACK_OPENAI: z
		.string()
		.optional()
		.transform((value) => (value ?? "false").toLowerCase() === "true"),
	TRANSCRIPT_INGEST_SECRET: z.string().optional(),
	EXTERNAL_PROJECTS_ENABLED: z
		.string()
		.optional()
		.transform((value) => (value ?? "true").toLowerCase() === "true"),
	THUMBNAIL_API_BASE: z.url().optional(),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export const webEnv = webEnvSchema.parse(process.env);
