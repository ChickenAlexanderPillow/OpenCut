import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
	id: text("id").primaryKey(),

	// todo: implement fully anonymous sign-in for privacy
	// we don't have any auth flows currently so this is fine for now
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	createdAt: timestamp("created_at")
		.$defaultFn(() => /* @__PURE__ */ new Date())
		.notNull(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => /* @__PURE__ */ new Date())
		.notNull(),
}).enableRLS();

export const sessions = pgTable("sessions", {
	id: text("id").primaryKey(),
	expiresAt: timestamp("expires_at").notNull(),
	token: text("token").notNull().unique(),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
}).enableRLS();

export const accounts = pgTable("accounts", {
	id: text("id").primaryKey(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at"),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
	scope: text("scope"),
	password: text("password"),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
}).enableRLS();

export const verifications = pgTable("verifications", {
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at").$defaultFn(
		() => /* @__PURE__ */ new Date(),
	),
	updatedAt: timestamp("updated_at").$defaultFn(
		() => /* @__PURE__ */ new Date(),
	),
}).enableRLS();

export const externalProjects = pgTable(
	"external_projects",
	{
		id: text("id").primaryKey(),
		sourceSystem: text("source_system").notNull(),
		externalProjectId: text("external_project_id").notNull(),
		name: text("name"),
		mode: text("mode"),
		sponsored: boolean("sponsored"),
		show: text("show"),
		sourceFilePath: text("source_file_path"),
		sourceAudioWavPath: text("source_audio_wav_path"),
		relativeKey: text("relative_key"),
		createdAt: timestamp("created_at")
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
		updatedAt: timestamp("updated_at")
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex("external_projects_source_external_uidx").on(
			table.sourceSystem,
			table.externalProjectId,
		),
		uniqueIndex("external_projects_source_relative_key_uidx").on(
			table.sourceSystem,
			table.relativeKey,
		),
	],
);

export const externalProjectTranscripts = pgTable("external_project_transcripts", {
	id: text("id").primaryKey(),
	projectId: text("project_id")
		.notNull()
		.references(() => externalProjects.id, { onDelete: "cascade" }),
	transcriptText: text("transcript_text").notNull(),
	segmentsJson: jsonb("segments_json").$type<
		Array<{ text: string; start: number; end: number }>
	>(),
	segmentsCount: integer("segments_count").notNull().default(0),
	audioDurationSeconds: integer("audio_duration_seconds"),
	qualityMetaJson: jsonb("quality_meta_json").$type<Record<string, unknown>>(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => /* @__PURE__ */ new Date())
		.notNull(),
});
