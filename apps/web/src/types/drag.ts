interface BaseDragData {
	id: string;
	name: string;
}

export interface MediaDragData extends BaseDragData {
	type: "media";
	mediaType: "image" | "video" | "audio";
}

export interface TextDragData extends BaseDragData {
	type: "text";
	content: string;
	raw?: Record<string, unknown>;
}

export interface StickerDragData extends BaseDragData {
	type: "sticker";
	stickerId: string;
}

export interface TransitionDragData extends BaseDragData {
	type: "transition";
	presetId: string;
}

export type TimelineDragData =
	| MediaDragData
	| TextDragData
	| StickerDragData
	| TransitionDragData;
