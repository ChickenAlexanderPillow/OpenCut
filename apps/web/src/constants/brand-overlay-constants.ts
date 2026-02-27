import type {
	TBrandLogoOverlayPreset,
	TBrandOverlays,
	TBrandPreset,
} from "@/types/project";

export const DEFAULT_BRAND_PRESET_ID = "builtin-default-brand";

export const BUILTIN_DEFAULT_BRAND_PRESET: TBrandPreset = {
	id: DEFAULT_BRAND_PRESET_ID,
	name: "Default Brand",
	builtIn: true,
	logo: {
		enabled: false,
		preset: "top-right",
		scale: 3,
		sourceUrl: null,
		sourceName: null,
		sourceWidth: null,
		sourceHeight: null,
	},
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

export const DEFAULT_BRAND_OVERLAYS: TBrandOverlays = {
	selectedBrandId: DEFAULT_BRAND_PRESET_ID,
	logo: {
		enabled: false,
		preset: "top-right",
		scale: 3,
		sourceUrl: null,
		sourceName: null,
		sourceWidth: null,
		sourceHeight: null,
	},
};

export const LOGO_OVERLAY_PRESET_CONFIG: Record<
	TBrandLogoOverlayPreset,
	{
		label: string;
		widthRatio: number;
		marginXRatio: number;
		marginYRatio: number;
		horizontal: "left" | "center" | "right";
		vertical: "top" | "bottom";
	}
> = {
	"top-right": {
		label: "Top right",
		widthRatio: 0.14,
		marginXRatio: 0.03,
		marginYRatio: 0.03,
		horizontal: "right",
		vertical: "top",
	},
	"top-center": {
		label: "Top middle",
		widthRatio: 0.14,
		marginXRatio: 0,
		marginYRatio: 0.03,
		horizontal: "center",
		vertical: "top",
	},
	"bottom-left": {
		label: "Bottom left",
		widthRatio: 0.14,
		marginXRatio: 0.03,
		marginYRatio: 0.03,
		horizontal: "left",
		vertical: "bottom",
	},
	"bottom-center": {
		label: "Bottom middle",
		widthRatio: 0.14,
		marginXRatio: 0,
		marginYRatio: 0.03,
		horizontal: "center",
		vertical: "bottom",
	},
	"top-right-compact": {
		label: "Top right compact",
		widthRatio: 0.1,
		marginXRatio: 0.03,
		marginYRatio: 0.03,
		horizontal: "right",
		vertical: "top",
	},
	"bottom-right": {
		label: "Bottom right",
		widthRatio: 0.14,
		marginXRatio: 0.03,
		marginYRatio: 0.03,
		horizontal: "right",
		vertical: "bottom",
	},
	"top-left": {
		label: "Top left",
		widthRatio: 0.14,
		marginXRatio: 0.03,
		marginYRatio: 0.03,
		horizontal: "left",
		vertical: "top",
	},
};
