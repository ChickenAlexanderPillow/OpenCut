"use client";

import { cn } from "@/utils/ui";
import { clamp } from "@/utils/math";
import { useRef, useState, type ComponentProps } from "react";
import { useFocusLock } from "@/hooks/use-focus-lock";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";

const DRAG_SENSITIVITIES = {
	default: 0.35,
	slow: 0.15,
} as const;
const SCRUB_START_THRESHOLD_PX = 3;
const MAX_POINTER_SCRUB_DELTA_PX = 48;
const POINTER_LOCK_STABILIZATION_MS = 120;

type DragSensitivity = "default" | "slow";

function parseOptionalFiniteNumber(
	value: number | string | undefined,
): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function clampScrubValue({
	value,
	min,
	max,
}: {
	value: number;
	min: number | string | undefined;
	max: number | string | undefined;
}): number {
	const parsedMin = parseOptionalFiniteNumber(min);
	const parsedMax = parseOptionalFiniteNumber(max);
	if (parsedMin === null && parsedMax === null) {
		return value;
	}
	return clamp({
		value,
		min: parsedMin ?? Number.NEGATIVE_INFINITY,
		max: parsedMax ?? Number.POSITIVE_INFINITY,
	});
}

interface NumberFieldProps
	extends Omit<ComponentProps<"input">, "size" | "type"> {
	icon?: React.ReactNode;
	dragSensitivity?: DragSensitivity;
	onScrub?: (value: number) => void;
	onScrubEnd?: () => void;
	allowExpressions?: boolean;
	onReset?: () => void;
	isDefault?: boolean;
}

function NumberField({
	className,
	icon,
	disabled,
	dragSensitivity = "default",
	onScrub,
	onScrubEnd,
	value,
	allowExpressions = true,
	onKeyDown,
	onFocus,
	onBlur,
	onMouseDown,
	onReset,
	isDefault = false,
	ref,
	...props
}: NumberFieldProps & { ref?: React.Ref<HTMLInputElement> }) {
	const iconRef = useRef<HTMLSpanElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const startValueRef = useRef(0);
	const cumulativeDeltaRef = useRef(0);
	const [isInputFocused, setIsInputFocused] = useState(false);

	const { containerRef: wrapperRef } = useFocusLock<HTMLDivElement>({
		isActive: isInputFocused,
		onDismiss: () => inputRef.current?.blur(),
		cursor: "text",
		allowSelector: "input, textarea, [contenteditable]",
	});

	const handleIconPointerDown = (event: React.PointerEvent) => {
		if (!onScrub || disabled || event.button !== 0) return;
		event.preventDefault();
		const parsed = parseFloat(String(value ?? "0"));
		startValueRef.current = Number.isNaN(parsed) ? 0 : parsed;
		cumulativeDeltaRef.current = 0;
		let hasReceivedFirstMove = false;
		let pointerLockAcquiredAt = 0;
		let hasStartedScrub = false;
		const startClientX = event.clientX;
		const startClientY = event.clientY;

		const handlePointerMove = (moveEvent: PointerEvent) => {
			if (!hasStartedScrub) {
				const deltaX = moveEvent.clientX - startClientX;
				const deltaY = moveEvent.clientY - startClientY;
				if (Math.hypot(deltaX, deltaY) < SCRUB_START_THRESHOLD_PX) {
					return;
				}
				hasStartedScrub = true;
				iconRef.current?.requestPointerLock();
				return;
			}
			if (document.pointerLockElement !== iconRef.current) {
				return;
			}
			if (
				pointerLockAcquiredAt > 0 &&
				performance.now() - pointerLockAcquiredAt <
					POINTER_LOCK_STABILIZATION_MS
			) {
				return;
			}
			// first movementX after pointer lock often contains a bogus warp delta
			if (!hasReceivedFirstMove) {
				hasReceivedFirstMove = true;
				return;
			}
			const safeMovementX = clamp({
				value: moveEvent.movementX,
				min: -MAX_POINTER_SCRUB_DELTA_PX,
				max: MAX_POINTER_SCRUB_DELTA_PX,
			});
			cumulativeDeltaRef.current += safeMovementX;
			const sensitivity =
				typeof dragSensitivity === "number"
					? dragSensitivity
					: DRAG_SENSITIVITIES[dragSensitivity];
			const nextValue =
				startValueRef.current + cumulativeDeltaRef.current * sensitivity;
			onScrub(
				clampScrubValue({
					value: nextValue,
					min: props.min,
					max: props.max,
				}),
			);
		};

		const cleanup = () => {
			document.removeEventListener("pointermove", handlePointerMove);
			document.removeEventListener("pointerup", handlePointerUp);
			document.removeEventListener(
				"pointerlockchange",
				handlePointerLockChange,
			);
		};

		const handlePointerUp = () => {
			cleanup();
			if (document.pointerLockElement === iconRef.current) {
				document.exitPointerLock();
			}
			if (hasStartedScrub) {
				onScrubEnd?.();
			}
		};

		const handlePointerLockChange = () => {
			if (document.pointerLockElement === iconRef.current) {
				pointerLockAcquiredAt = performance.now();
				hasReceivedFirstMove = false;
				return;
			}
			cleanup();
		};

		document.addEventListener("pointermove", handlePointerMove);
		document.addEventListener("pointerup", handlePointerUp);
		document.addEventListener("pointerlockchange", handlePointerLockChange);
	};

	const canScrub = Boolean(icon && onScrub);

	return (
		<div
			ref={wrapperRef}
			className={cn(
				"border-border bg-accent flex h-7 w-full min-w-0 items-center rounded-md border text-sm outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-within:border-primary focus-within:ring-0 focus-within:ring-primary/10 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
				disabled && "pointer-events-none cursor-not-allowed opacity-50",
				className,
			)}
		>
			{icon && (
				<span
					ref={iconRef}
					className={cn(
						"text-muted-foreground [&_svg]:!size-3.5 shrink-0 select-none pl-2.5 text-sm leading-none",
						canScrub && "cursor-ew-resize",
					)}
					onPointerDown={canScrub ? handleIconPointerDown : undefined}
				>
					{icon}
				</span>
			)}
			<input
				type={allowExpressions ? "text" : "number"}
				inputMode={allowExpressions ? "decimal" : undefined}
				ref={inputRef}
				disabled={disabled}
				value={value}
				className={cn(
					"min-w-0 flex-1 text-sm leading-none bg-transparent outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
					icon ? "px-1.5" : "pl-2.5",
					onReset ? "pr-0" : "pr-2.5",
				)}
				onMouseDown={(event) => {
					const inputElement = event.currentTarget;
					const shouldPreventNativeCaretPlacement =
						event.button === 0 && document.activeElement !== inputElement;
					if (shouldPreventNativeCaretPlacement) {
						event.preventDefault();
						inputElement.focus();
						inputElement.select();
					}
					onMouseDown?.(event);
				}}
				onFocus={(event) => {
					setIsInputFocused(true);
					event.currentTarget.select();
					onFocus?.(event);
				}}
				onKeyDown={(event) => {
					const shouldBlurInput =
						event.key === "Enter" || event.key === "Escape";
					if (shouldBlurInput) event.currentTarget.blur();
					onKeyDown?.(event);
				}}
				onBlur={(event) => {
					setIsInputFocused(false);
					onBlur?.(event);
				}}
				{...props}
			/>
			{onReset && !isDefault && (
				<div className="shrink-0 pr-2 flex items-center">
					<Button
						variant="text"
						size="text"
						aria-label="Reset to default"
						onClick={onReset}
					>
						<HugeiconsIcon icon={ArrowTurnBackwardIcon} className="!size-3.5" />
					</Button>
				</div>
			)}
		</div>
	);
}

export { NumberField };
