"use client";

import { useEffect, useRef, useState } from "react";
import { formatTimeCode, parseTimeCode } from "@/lib/time";
import type { TTimeCode } from "@/types/time";
import { cn } from "@/utils/ui";

interface EditableTimecodeProps {
	time: number;
	duration: number;
	format?: TTimeCode;
	fps: number;
	onTimeChange?: ({ time }: { time: number }) => void;
	enableScrub?: boolean;
	className?: string;
	disabled?: boolean;
}

export function EditableTimecode({
	time,
	duration,
	format = "HH:MM:SS:FF",
	fps,
	onTimeChange,
	enableScrub = false,
	className,
	disabled = false,
}: EditableTimecodeProps) {
	const [isEditing, setIsEditing] = useState(false);
	const [inputValue, setInputValue] = useState("");
	const [hasError, setHasError] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const enterPressedRef = useRef(false);
	const displayRef = useRef<HTMLButtonElement>(null);
	const scrubStartTimeRef = useRef(0);
	const scrubStartClientXRef = useRef(0);
	const scrubDeltaXRef = useRef(0);
	const scrubDraggedRef = useRef(false);
	const pointerLockActiveRef = useRef(false);
	const ignoreFirstLockedMoveRef = useRef(false);
	const scrubAnimationFrameRef = useRef<number | null>(null);
	const formattedTime = formatTimeCode({ timeInSeconds: time, format, fps });
	const secondsPerPixel = 1 / Math.max(1, fps * 2);

	const startEditing = () => {
		if (disabled) return;
		setIsEditing(true);
		setInputValue(formattedTime);
		setHasError(false);
		enterPressedRef.current = false;
	};

	const handleDisplayClick = () => {
		if (enableScrub && scrubDraggedRef.current) {
			scrubDraggedRef.current = false;
			return;
		}
		startEditing();
	};

	const cancelEditing = () => {
		setIsEditing(false);
		setInputValue("");
		setHasError(false);
		enterPressedRef.current = false;
	};

	const applyEdit = () => {
		const parsedTime = parseTimeCode({ timeCode: inputValue, format, fps });

		if (parsedTime === null) {
			setHasError(true);
			return;
		}

		const clampedTime = Math.max(
			0,
			duration ? Math.min(duration, parsedTime) : parsedTime,
		);

		onTimeChange?.({ time: clampedTime });
		setIsEditing(false);
		setInputValue("");
		setHasError(false);
		enterPressedRef.current = false;
	};

	const handleKeyDown = ({
		key,
		preventDefault,
	}: React.KeyboardEvent<HTMLInputElement>) => {
		if (key === "Enter") {
			preventDefault();
			enterPressedRef.current = true;
			applyEdit();
		} else if (key === "Escape") {
			preventDefault();
			cancelEditing();
		}
	};

	const handleInputChange = ({
		target,
	}: React.ChangeEvent<HTMLInputElement>) => {
		setInputValue(target.value);
		setHasError(false);
	};

	const handleBlur = () => {
		if (!enterPressedRef.current && isEditing) {
			applyEdit();
		}
	};

	const handleDisplayKeyDown = ({
		key,
		preventDefault,
	}: React.KeyboardEvent<HTMLButtonElement>) => {
		if (disabled) return;

		if (key === "Enter" || key === " ") {
			preventDefault();
			startEditing();
		}
	};

	const commitScrub = ({ deltaX }: { deltaX: number }) => {
		const rawTime = scrubStartTimeRef.current + deltaX * secondsPerPixel;
		const clampedTime = Math.max(0, Math.min(duration, rawTime));
		onTimeChange?.({ time: clampedTime });
	};

	const stopScrub = () => {
		if (
			typeof document !== "undefined" &&
			document.pointerLockElement &&
			typeof document.exitPointerLock === "function"
		) {
			try {
				document.exitPointerLock();
			} catch {}
		}
		pointerLockActiveRef.current = false;
		if (scrubAnimationFrameRef.current !== null) {
			window.cancelAnimationFrame(scrubAnimationFrameRef.current);
			scrubAnimationFrameRef.current = null;
		}
		document.removeEventListener("pointermove", handleScrubPointerMove);
		document.removeEventListener("pointerup", stopScrub);
		document.removeEventListener("pointercancel", stopScrub);
		document.removeEventListener("pointerlockchange", handlePointerLockChange);
	};

	const handlePointerLockChange = () => {
		pointerLockActiveRef.current = document.pointerLockElement === displayRef.current;
	};

	const handleScrubPointerMove = (event: PointerEvent) => {
		if (pointerLockActiveRef.current) {
			if (ignoreFirstLockedMoveRef.current) {
				ignoreFirstLockedMoveRef.current = false;
				return;
			}
			scrubDeltaXRef.current += event.movementX;
		} else {
			scrubDeltaXRef.current = event.clientX - scrubStartClientXRef.current;
		}
		if (!scrubDraggedRef.current && Math.abs(scrubDeltaXRef.current) >= 2) {
			scrubDraggedRef.current = true;
		}
		if (!scrubDraggedRef.current) return;
		if (scrubAnimationFrameRef.current !== null) return;
		scrubAnimationFrameRef.current = window.requestAnimationFrame(() => {
			scrubAnimationFrameRef.current = null;
			commitScrub({ deltaX: scrubDeltaXRef.current });
		});
	};

	const handleDisplayPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
		if (!enableScrub || disabled || isEditing || event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		scrubStartTimeRef.current = time;
		scrubStartClientXRef.current = event.clientX;
		scrubDeltaXRef.current = 0;
		scrubDraggedRef.current = false;
		ignoreFirstLockedMoveRef.current = true;
		const target = event.currentTarget;
		if (typeof target.requestPointerLock === "function") {
			try {
				target.requestPointerLock();
			} catch {}
		}
		document.addEventListener("pointerlockchange", handlePointerLockChange);
		document.addEventListener("pointermove", handleScrubPointerMove);
		document.addEventListener("pointerup", stopScrub, { once: true });
		document.addEventListener("pointercancel", stopScrub, { once: true });
	};

	useEffect(() => {
		if (isEditing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isEditing]);

	useEffect(() => {
		return () => {
			stopScrub();
		};
	}, []);

	if (isEditing) {
		return (
			<input
				ref={inputRef}
				type="text"
				value={inputValue}
				onChange={handleInputChange}
				onKeyDown={handleKeyDown}
				onBlur={handleBlur}
				className={cn(
					"-mx-1 border border-transparent bg-transparent px-1 font-mono text-xs outline-none",
					"focus:bg-background focus:border-primary focus:rounded",
					"text-primary tabular-nums",
					hasError && "text-destructive focus:border-destructive",
					className,
				)}
				style={{ width: `${formattedTime.length + 1}ch` }}
				placeholder={formattedTime}
			/>
		);
	}

	return (
		<button
			ref={displayRef}
			type="button"
			onClick={handleDisplayClick}
			onKeyDown={handleDisplayKeyDown}
			onPointerDown={handleDisplayPointerDown}
			disabled={disabled}
			className={cn(
				"text-primary cursor-pointer font-mono text-xs tabular-nums",
				"hover:bg-muted/50 -mx-1 px-1 hover:rounded",
				enableScrub && "cursor-ew-resize",
				disabled && "cursor-default hover:bg-transparent",
				className,
			)}
			title={
				disabled
					? undefined
					: enableScrub
						? "Drag left/right to scrub, click to edit time"
						: "Click to edit time"
			}
		>
			{formattedTime}
		</button>
	);
}
