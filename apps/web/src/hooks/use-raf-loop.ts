import { useEffect, useRef } from "react";

export function useRafLoop(
	callback: ({ time }: { time: number }) => void,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	const requestRef = useRef<number>(0);
	const previousTimeRef = useRef<number | null>(null);

	useEffect(() => {
		if (!enabled) {
			previousTimeRef.current = null;
			return;
		}

		const loop = ({ time }: { time: number }) => {
			if (previousTimeRef.current !== null) {
				const deltaTime = time - previousTimeRef.current;
				callback({ time: deltaTime });
			}
			previousTimeRef.current = time;
			requestRef.current = requestAnimationFrame((time) => loop({ time }));
		};

		requestRef.current = requestAnimationFrame((time) => loop({ time }));
		return () => {
			if (requestRef.current) {
				cancelAnimationFrame(requestRef.current);
			}
		};
	}, [callback, enabled]);
}
