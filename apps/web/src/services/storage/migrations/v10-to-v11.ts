import { StorageMigration } from "./base";
import { transformProjectV10ToV11 } from "./transformers/v10-to-v11";
import type { MigrationResult, ProjectRecord } from "./transformers/types";

export class V10toV11Migration extends StorageMigration {
	from = 10;
	to = 11;

	async transform(project: ProjectRecord): Promise<MigrationResult<ProjectRecord>> {
		return transformProjectV10ToV11({ project });
	}
}
