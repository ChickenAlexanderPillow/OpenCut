import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
	BUILTIN_DEFAULT_BRAND_PRESET,
	DEFAULT_BRAND_OVERLAYS,
	DEFAULT_BRAND_PRESET_ID,
} from "@/constants/brand-overlay-constants";
import type { TBrandLogoOverlayConfig, TBrandLogoOverlayPreset, TBrandPreset } from "@/types/project";
import { useLocalStorage } from "@/hooks/storage/use-local-storage";
import { RefreshCw, Save, Trash2 } from "lucide-react";
import { NumberField } from "@/components/ui/number-field";

const BRAND_PRESETS_STORAGE_KEY = "brand-overlay-presets:v1";
const LOGO_SCALE_UI_BASE = 3;

function toLogoScalePercent({
	storedScale,
}: {
	storedScale: number;
}): number {
	return Math.round((storedScale / LOGO_SCALE_UI_BASE) * 100);
}

function fromLogoScalePercent({
	percent,
}: {
	percent: number;
}): number {
	const clampedPercent = Math.max(20, Math.min(300, percent));
	return (clampedPercent / 100) * LOGO_SCALE_UI_BASE;
}

export function OverlayView() {
	const editor = useEditor();
	const containerRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const activeProject = editor.project.getActive();
	const projectBrandOverlays =
		activeProject.brandOverlays ?? DEFAULT_BRAND_OVERLAYS;

	const [storedBrands, setStoredBrands, isBrandsReady] = useLocalStorage<
		TBrandPreset[]
	>({
		key: BRAND_PRESETS_STORAGE_KEY,
		defaultValue: [BUILTIN_DEFAULT_BRAND_PRESET],
	});

	const brandPresets = useMemo(() => {
		const builtInOverride = storedBrands.find(
			(preset) => preset.id === DEFAULT_BRAND_PRESET_ID,
		);
		const builtIn = builtInOverride
			? { ...builtInOverride, builtIn: true }
			: BUILTIN_DEFAULT_BRAND_PRESET;
		const custom = storedBrands.filter(
			(preset) => preset.id !== DEFAULT_BRAND_PRESET_ID,
		);
		return [builtIn, ...custom];
	}, [storedBrands]);

	const [selectedBrandId, setSelectedBrandId] = useState(
		projectBrandOverlays.selectedBrandId ?? DEFAULT_BRAND_PRESET_ID,
	);
	const [brandName, setBrandName] = useState("");
	const [logoEnabled, setLogoEnabled] = useState(false);
	const [logoPreset, setLogoPreset] =
		useState<TBrandLogoOverlayPreset>("top-right");
	const [logoScale, setLogoScale] = useState(LOGO_SCALE_UI_BASE);
	const [logoSourceUrl, setLogoSourceUrl] = useState<string | null>(null);
	const [logoSourceName, setLogoSourceName] = useState<string | null>(null);
	const [logoSourceWidth, setLogoSourceWidth] = useState<number | null>(null);
	const [logoSourceHeight, setLogoSourceHeight] = useState<number | null>(null);

	const selectedBrand =
		brandPresets.find((brand) => brand.id === selectedBrandId) ??
		brandPresets[0] ??
		BUILTIN_DEFAULT_BRAND_PRESET;

	useEffect(() => {
		if (!isBrandsReady) return;
		if (brandPresets.some((brand) => brand.id === selectedBrandId)) return;
		setSelectedBrandId(DEFAULT_BRAND_PRESET_ID);
	}, [brandPresets, selectedBrandId, isBrandsReady]);

	useEffect(() => {
		if (!selectedBrand) return;
		setBrandName(selectedBrand.name);
		setLogoEnabled(selectedBrand.logo.enabled);
		setLogoPreset(selectedBrand.logo.preset);
		setLogoScale(selectedBrand.logo.scale ?? LOGO_SCALE_UI_BASE);
		setLogoSourceUrl(selectedBrand.logo.sourceUrl ?? null);
		setLogoSourceName(selectedBrand.logo.sourceName ?? null);
		setLogoSourceWidth(selectedBrand.logo.sourceWidth ?? null);
		setLogoSourceHeight(selectedBrand.logo.sourceHeight ?? null);
	}, [selectedBrand]);

	const applyBrandToProject = ({
		brandId,
		logo,
	}: {
		brandId: string;
		logo: TBrandLogoOverlayConfig;
	}) => {
		const currentProject = editor.project.getActive();
		const currentOverlays = currentProject.brandOverlays ?? DEFAULT_BRAND_OVERLAYS;
		const updatedProject = {
			...currentProject,
			brandOverlays: {
				...currentOverlays,
				selectedBrandId: brandId,
				logo,
			},
		};
		editor.project.setActiveProject({ project: updatedProject });
		editor.save.markDirty();
	};

	const currentLogoConfig: TBrandLogoOverlayConfig = {
		enabled: logoEnabled,
		preset: logoPreset,
		scale: logoScale,
		sourceUrl: logoSourceUrl,
		sourceName: logoSourceName,
		sourceWidth: logoSourceWidth,
		sourceHeight: logoSourceHeight,
	};

	const saveNewBrand = () => {
		const name = brandName.trim();
		if (!name) {
			toast.error("Brand name is required");
			return;
		}
		const nextId = `brand-${Date.now()}`;
		const now = new Date().toISOString();
		const newBrand: TBrandPreset = {
			id: nextId,
			name,
			logo: currentLogoConfig,
			createdAt: now,
			updatedAt: now,
		};
		setStoredBrands({
			value: (previous) => {
				const custom = previous.filter((item) => item.id !== DEFAULT_BRAND_PRESET_ID);
				return [BUILTIN_DEFAULT_BRAND_PRESET, ...custom, newBrand];
			},
		});
		setSelectedBrandId(nextId);
		applyBrandToProject({ brandId: nextId, logo: currentLogoConfig });
		toast.success(`Saved brand "${name}"`);
	};

	const updateBrand = () => {
		if (!selectedBrand) return;
		const name = brandName.trim();
		if (!name) {
			toast.error("Brand name is required");
			return;
		}
		const updatedBrand: TBrandPreset = {
			...selectedBrand,
			name,
			logo: currentLogoConfig,
			updatedAt: new Date().toISOString(),
		};
		setStoredBrands({
			value: (previous) => {
				const index = previous.findIndex((item) => item.id === selectedBrand.id);
				if (index === -1) return [...previous, updatedBrand];
				return previous.map((item) =>
					item.id === selectedBrand.id ? updatedBrand : item,
				);
			},
		});
		applyBrandToProject({ brandId: selectedBrand.id, logo: currentLogoConfig });
		toast.success(`Updated brand "${name}"`);
	};

	const deleteBrand = () => {
		if (!selectedBrand || selectedBrand.builtIn) return;
		setStoredBrands({
			value: (previous) =>
				previous.filter((item) => item.id !== selectedBrand.id),
		});
		setSelectedBrandId(DEFAULT_BRAND_PRESET_ID);
		applyBrandToProject({
			brandId: DEFAULT_BRAND_PRESET_ID,
			logo: BUILTIN_DEFAULT_BRAND_PRESET.logo,
		});
		toast.success(`Deleted brand "${selectedBrand.name}"`);
	};

	const handleSelectBrand = (brandId: string) => {
		setSelectedBrandId(brandId);
		const brand =
			brandPresets.find((item) => item.id === brandId) ??
			BUILTIN_DEFAULT_BRAND_PRESET;
		applyBrandToProject({ brandId: brand.id, logo: brand.logo });
	};

	const handleLogoFilePick = async ({
		file,
	}: {
		file: File;
	}) => {
		const imageDimensions = await new Promise<{ width: number; height: number }>(
			(resolve, reject) => {
				const objectUrl = URL.createObjectURL(file);
				const image = new Image();
				image.onload = () => {
					resolve({ width: image.naturalWidth, height: image.naturalHeight });
					URL.revokeObjectURL(objectUrl);
				};
				image.onerror = () => {
					URL.revokeObjectURL(objectUrl);
					reject(new Error("Failed to load image"));
				};
				image.src = objectUrl;
			},
		);
		const dataUrl = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				if (typeof reader.result === "string") resolve(reader.result);
				else reject(new Error("Failed to read file"));
			};
			reader.onerror = () => reject(new Error("Failed to read file"));
			reader.readAsDataURL(file);
		});
		setLogoSourceUrl(dataUrl);
		setLogoSourceName(file.name);
		setLogoSourceWidth(imageDimensions.width);
		setLogoSourceHeight(imageDimensions.height);
		applyBrandToProject({
			brandId: selectedBrandId,
			logo: {
				...currentLogoConfig,
				sourceUrl: dataUrl,
				sourceName: file.name,
				sourceWidth: imageDimensions.width,
				sourceHeight: imageDimensions.height,
			},
		});
		toast.success("Logo uploaded for current brand draft");
	};

	return (
		<PanelView
			title="Overlay"
			ref={containerRef}
			contentClassName="space-y-3 pb-3"
		>
			<input
				ref={fileInputRef}
				type="file"
				accept="image/*"
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (!file) return;
					void handleLogoFilePick({ file });
					event.currentTarget.value = "";
				}}
			/>
			<div className="rounded-md border p-3 space-y-2">
				<Label>Brand</Label>
				<Select value={selectedBrandId} onValueChange={handleSelectBrand}>
					<SelectTrigger>
						<SelectValue placeholder="Select brand" />
					</SelectTrigger>
					<SelectContent>
						{brandPresets.map((brand) => (
							<SelectItem key={brand.id} value={brand.id}>
								{brand.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Input
					size="sm"
					value={brandName}
					onChange={(event) => setBrandName(event.target.value)}
					placeholder="Brand name"
				/>
				<div className="grid grid-cols-3 gap-2">
					<Button size="sm" variant="secondary" onClick={saveNewBrand}>
						<Save />
						Save New
					</Button>
					<Button size="sm" variant="outline" onClick={updateBrand}>
						<RefreshCw />
						Update
					</Button>
					<Button
						size="sm"
						variant="destructive-foreground"
						onClick={deleteBrand}
						disabled={selectedBrand?.builtIn}
					>
						<Trash2 />
						Delete
					</Button>
				</div>
			</div>

			<div className="rounded-md border p-3 space-y-2">
				<div className="flex items-center gap-2">
					<Checkbox
						id="brand-logo-enabled"
						checked={logoEnabled}
						onCheckedChange={(checked) => {
							const next = Boolean(checked);
							setLogoEnabled(next);
							applyBrandToProject({
								brandId: selectedBrandId,
								logo: { ...currentLogoConfig, enabled: next },
							});
						}}
					/>
					<Label htmlFor="brand-logo-enabled">Enable logo overlay</Label>
				</div>
				<div className="space-y-1.5">
					<Label>Position</Label>
					<div className="grid grid-cols-3 gap-2">
						{(
							[
								["top-left", "Top left"],
								["top-center", "Top middle"],
								["top-right", "Top right"],
								["bottom-left", "Bottom left"],
								["bottom-center", "Bottom middle"],
								["bottom-right", "Bottom right"],
							] as Array<[TBrandLogoOverlayPreset, string]>
						).map(([preset, label]) => (
							<Button
								key={preset}
								size="sm"
								variant={logoPreset === preset ? "secondary" : "outline"}
								onClick={() => {
									setLogoPreset(preset);
									applyBrandToProject({
										brandId: selectedBrandId,
										logo: { ...currentLogoConfig, preset },
									});
								}}
								className="justify-center"
								title={label}
								aria-label={label}
							>
								<span className="grid grid-cols-3 grid-rows-2 gap-1">
									{Array.from({ length: 6 }).map((_, index) => {
										const activeIndexMap: Record<
											TBrandLogoOverlayPreset,
											number
										> = {
											"top-left": 0,
											"top-center": 1,
											"top-right": 2,
											"top-right-compact": 2,
											"bottom-left": 3,
											"bottom-center": 4,
											"bottom-right": 5,
										};
										const activeIndex = activeIndexMap[preset];
										return (
											<span
												key={`${preset}-${index}`}
												className={
													index === activeIndex
														? "size-1.5 rounded-full bg-current"
														: "size-1.5 rounded-full bg-current/25"
												}
											/>
										);
									})}
								</span>
							</Button>
						))}
					</div>
				</div>
				<div className="space-y-1.5">
					<Label>Scale</Label>
					<NumberField
						value={toLogoScalePercent({ storedScale: logoScale }).toString()}
						min={20}
						max={300}
						icon="%"
						onChange={(event) => {
							const parsed = Number.parseFloat(event.target.value);
							if (Number.isNaN(parsed)) return;
							const next = fromLogoScalePercent({ percent: parsed });
							setLogoScale(next);
							applyBrandToProject({
								brandId: selectedBrandId,
								logo: { ...currentLogoConfig, scale: next },
							});
						}}
						onScrub={(value) => {
							const next = fromLogoScalePercent({
								percent: Math.round(value),
							});
							setLogoScale(next);
							applyBrandToProject({
								brandId: selectedBrandId,
								logo: { ...currentLogoConfig, scale: next },
							});
						}}
						onReset={() => {
							const next = LOGO_SCALE_UI_BASE;
							setLogoScale(next);
							applyBrandToProject({
								brandId: selectedBrandId,
								logo: { ...currentLogoConfig, scale: next },
							});
						}}
						isDefault={Math.abs(logoScale - LOGO_SCALE_UI_BASE) < 0.001}
					/>
				</div>
				<div className="space-y-1.5">
					<Label>Logo media</Label>
					<Button
						size="sm"
						variant="outline"
						onClick={() => fileInputRef.current?.click()}
					>
						Upload logo
					</Button>
					<div className="text-muted-foreground text-xs">
						{logoSourceName ?? "No logo uploaded"}
					</div>
				</div>
			</div>
		</PanelView>
	);
}
