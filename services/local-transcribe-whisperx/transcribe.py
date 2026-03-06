from __future__ import annotations

from collections import OrderedDict
import gc
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel
import torch
import whisperx


@dataclass
class TranscribeConfig:
	model: str = "medium"
	device: str = "cuda"
	compute_type: str = "int8_float16"
	vad_filter: bool = False
	language: str | None = None


class LocalWhisperXEngine:
	def __init__(self) -> None:
		self._max_model_cache = max(1, int(os.getenv("LOCAL_TRANSCRIBE_MAX_MODEL_CACHE", "1")))
		self._max_align_cache = max(1, int(os.getenv("LOCAL_TRANSCRIBE_MAX_ALIGN_CACHE", "2")))
		self._model_cache: "OrderedDict[tuple[str, str, str], WhisperModel]" = OrderedDict()
		self._align_cache: "OrderedDict[tuple[str, str], tuple[Any, Any]]" = OrderedDict()

	def _release_runtime_memory(self, *, clear_cuda_cache: bool) -> None:
		gc.collect()
		if not clear_cuda_cache:
			return
		try:
			if torch.cuda.is_available():
				torch.cuda.empty_cache()
		except Exception:
			pass

	def _trim_caches(self) -> bool:
		evicted = False
		while len(self._model_cache) > self._max_model_cache:
			self._model_cache.popitem(last=False)
			evicted = True
		while len(self._align_cache) > self._max_align_cache:
			self._align_cache.popitem(last=False)
			evicted = True
		if evicted:
			# Keep VRAM warm between requests; only run GC when we evict cache entries.
			self._release_runtime_memory(clear_cuda_cache=False)
		return evicted

	def _resolve_device(self, requested: str) -> str:
		device = (requested or "cpu").strip().lower()
		if not device.startswith("cuda"):
			return device
		try:
			if torch.cuda.is_available() and torch.backends.cudnn.is_available():
				return "cuda"
		except Exception:
			pass
		return "cpu"

	def _get_asr_model(self, *, model: str, device: str, compute_type: str) -> WhisperModel:
		key = (model, device, compute_type)
		existing = self._model_cache.get(key)
		if existing:
			self._model_cache.move_to_end(key)
			return existing
		asr_model = WhisperModel(model, device=device, compute_type=compute_type)
		self._model_cache[key] = asr_model
		self._trim_caches()
		return asr_model

	def _get_align_model(self, *, language: str, device: str) -> tuple[Any, Any]:
		key = (language, device)
		existing = self._align_cache.get(key)
		if existing:
			self._align_cache.move_to_end(key)
			return existing
		align_model, metadata = whisperx.load_align_model(
			language_code=language,
			device=device,
		)
		self._align_cache[key] = (align_model, metadata)
		self._trim_caches()
		return align_model, metadata

	def get_runtime_device_info(self) -> dict[str, Any]:
		cuda_available = False
		cudnn_available = False
		cuda_device_count = 0
		cuda_device_name: str | None = None
		try:
			cuda_available = bool(torch.cuda.is_available())
			cudnn_available = bool(torch.backends.cudnn.is_available())
			if cuda_available:
				cuda_device_count = int(torch.cuda.device_count())
				if cuda_device_count > 0:
					cuda_device_name = str(torch.cuda.get_device_name(0))
		except Exception:
			pass
		return {
			"cuda_available": cuda_available,
			"cudnn_available": cudnn_available,
			"cuda_device_count": cuda_device_count,
			"cuda_device_name": cuda_device_name,
			"torch_version": getattr(torch, "__version__", "unknown"),
			"torch_cuda_version": getattr(torch.version, "cuda", None),
		}

	def _run_asr(
		self,
		*,
		audio: Any,
		model: str,
		device: str,
		compute_type: str,
		vad_filter: bool,
		language: str | None,
	) -> dict[str, Any]:
		asr_model = self._get_asr_model(
			model=model,
			device=device,
			compute_type=compute_type,
		)
		effective_language = (language or "").strip().lower() or None
		segments_iter, info = asr_model.transcribe(
			audio,
			beam_size=1,
			word_timestamps=True,
			vad_filter=vad_filter,
			language=effective_language,
		)
		segments: list[dict[str, Any]] = []
		for segment in segments_iter:
			segments.append(
				{
					"start": float(segment.start),
					"end": float(segment.end),
					"text": segment.text,
				}
			)
		return {
			"segments": segments,
			"language": getattr(info, "language", "en"),
		}

	def transcribe_file_with_alignment(
		self,
		*,
		audio_path: Path,
		config: TranscribeConfig,
	) -> dict[str, Any]:
		total_started_at = time.perf_counter()
		timings_ms: dict[str, float] = {}

		# whisperx.load_audio normalizes to mono 16k via ffmpeg.
		load_audio_started_at = time.perf_counter()
		audio = whisperx.load_audio(str(audio_path))
		timings_ms["load_audio"] = (time.perf_counter() - load_audio_started_at) * 1000.0
		audio_duration_seconds = (
			max(0.0, float(len(audio)) / 16000.0) if hasattr(audio, "__len__") else 0.0
		)
		used_device = self._resolve_device(config.device)
		asr_started_at = time.perf_counter()
		try:
			asr_result = self._run_asr(
				audio=audio,
				model=config.model,
				device=used_device,
				compute_type=config.compute_type,
				vad_filter=config.vad_filter,
				language=config.language,
			)
			used_model = config.model
			used_compute = config.compute_type
		except RuntimeError:
			# OOM/compute fallback. Clear allocator cache once before retry.
			self._release_runtime_memory(clear_cuda_cache=used_device.startswith("cuda"))
			fallback_model = "medium" if config.model != "medium" else config.model
			fallback_compute = "int8_float16" if used_device.startswith("cuda") else "int8"
			asr_result = self._run_asr(
				audio=audio,
				model=fallback_model,
				device=used_device,
				compute_type=fallback_compute,
				vad_filter=config.vad_filter,
				language=config.language,
			)
			used_model = fallback_model
			used_compute = fallback_compute
		except Exception:
			# CUDA/cuDNN missing/unavailable fallback
			used_device = "cpu"
			fallback_model = "medium" if config.model != "medium" else config.model
			fallback_compute = "int8"
			asr_result = self._run_asr(
				audio=audio,
				model=fallback_model,
				device=used_device,
				compute_type=fallback_compute,
				vad_filter=config.vad_filter,
				language=config.language,
			)
			used_model = fallback_model
			used_compute = fallback_compute
		timings_ms["asr"] = (time.perf_counter() - asr_started_at) * 1000.0

		language = asr_result["language"] or "en"
		align_started_at = time.perf_counter()
		align_model, metadata = self._get_align_model(
			language=language,
			device=used_device,
		)
		try:
			aligned = whisperx.align(
				asr_result["segments"],
				align_model,
				metadata,
				audio,
				used_device,
				return_char_alignments=False,
			)
		except Exception:
			if used_device != "cpu":
				used_device = "cpu"
				align_model, metadata = self._get_align_model(
					language=language,
					device=used_device,
				)
				aligned = whisperx.align(
					asr_result["segments"],
					align_model,
					metadata,
					audio,
					used_device,
					return_char_alignments=False,
				)
			else:
				raise
		timings_ms["align"] = (time.perf_counter() - align_started_at) * 1000.0
		word_segments = aligned.get("word_segments", []) or []
		postprocess_started_at = time.perf_counter()
		words = []
		for item in word_segments:
			word = (item.get("word") or "").strip()
			start = item.get("start")
			end = item.get("end")
			if not word or start is None or end is None:
				continue
			start_f = max(0.0, float(start))
			end_f = max(start_f + 0.01, float(end))
			words.append(
				{
					"word": word,
					"start": start_f,
					"end": end_f,
				}
			)
		timings_ms["postprocess"] = (time.perf_counter() - postprocess_started_at) * 1000.0
		total_ms = (time.perf_counter() - total_started_at) * 1000.0
		timings_ms["total"] = total_ms

		return {
			"text": " ".join(segment.get("text", "").strip() for segment in asr_result["segments"]).strip(),
			"words": words,
			"language": language,
			"model": used_model,
			"compute_type": used_compute,
			"device": used_device,
			"engine": "whisperx",
			"timings_ms": timings_ms,
			"audio_duration_seconds": audio_duration_seconds,
			"word_count": len(words),
		}

	def prewarm(
		self,
		*,
		model: str,
		device: str,
		compute_type: str,
		language: str | None,
	) -> dict[str, Any]:
		resolved_device = self._resolve_device(device)
		self._get_asr_model(
			model=model,
			device=resolved_device,
			compute_type=compute_type,
		)
		effective_language = (language or "").strip().lower() or "en"
		self._get_align_model(
			language=effective_language,
			device=resolved_device,
		)
		return {
			"model": model,
			"compute_type": compute_type,
			"requested_device": device,
			"resolved_device": resolved_device,
			"language": effective_language,
		}
