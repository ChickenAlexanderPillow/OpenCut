CREATE TABLE "external_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"source_system" text NOT NULL,
	"external_project_id" text NOT NULL,
	"name" text,
	"mode" text,
	"sponsored" boolean,
	"show" text,
	"source_file_path" text,
	"source_audio_wav_path" text,
	"relative_key" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_project_transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"transcript_text" text NOT NULL,
	"segments_json" jsonb,
	"segments_count" integer DEFAULT 0 NOT NULL,
	"audio_duration_seconds" integer,
	"quality_meta_json" jsonb,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_project_transcripts" ADD CONSTRAINT "external_project_transcripts_project_id_external_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."external_projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "external_projects_source_external_uidx" ON "external_projects" USING btree ("source_system","external_project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "external_projects_source_relative_key_uidx" ON "external_projects" USING btree ("source_system","relative_key");
