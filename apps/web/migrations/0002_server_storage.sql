CREATE TABLE "editor_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"document_json" jsonb NOT NULL,
	"document_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "editor_media_assets" (
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text,
	"type" text,
	"mime_type" text,
	"size_bytes" bigint,
	"last_modified" bigint,
	"width" integer,
	"height" integer,
	"duration_seconds" real,
	"fps" real,
	"thumbnail_url" text,
	"preview_proxy_width" integer,
	"preview_proxy_height" integer,
	"preview_proxy_fps" integer,
	"preview_proxy_quality_ratio" real,
	"object_key" text NOT NULL,
	"preview_object_key" text,
	"sha256" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "editor_media_assets_pk" PRIMARY KEY("project_id","id")
);
--> statement-breakpoint
ALTER TABLE "editor_media_assets" ADD CONSTRAINT "editor_media_assets_project_id_editor_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."editor_projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "editor_media_assets_project_idx" ON "editor_media_assets" USING btree ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "editor_media_assets_project_sha256_uidx" ON "editor_media_assets" USING btree ("project_id","sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX "editor_media_assets_project_object_key_uidx" ON "editor_media_assets" USING btree ("project_id","object_key");
