from __future__ import annotations

from collections import OrderedDict
import gc
import os
import tempfile
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


class LocalWhisperXEngine:
	def __init__(self) -> None:
		self._max_model_cache = max(1, int(os.getenv("LOCAL_TRANSCRIBE_MAX_MODEL_CACHE", "1")))
		self._max_align_cache = max(1, int(os.getenv("LOCAL_TRANSCRIBE_MAX_ALIGN_CACHE", "2")))
		self._model_cache: "OrderedDict[tuple[str, str, str], WhisperModel]" = OrderedDict()
		self._align_cache: "OrderedDict[tuple[str, str], tuple[Any, Any]]" = OrderedDict()

	def _trim_caches(self) -> None:
		while len(self._model_cache) > self._max_model_cache:
			self._model_cache.popitem(last=False)
		while len(self._align_cache) > self._max_align_cache:
			self._align_cache.popitem(last=False)
		gc.collect()
		try:
			if torch.cuda.is_available():
				torch.cuda.empty_cache()
		except Exception:
			pass

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

	def _run_asr(
		self,
		*,
		audio: Any,
		model: str,
		device: str,
		compute_type: str,
		vad_filter: bool,
	) -> dict[str, Any]:
		asr_model = self._get_asr_model(
			model=model,
			device=device,
			compute_type=compute_type,
		)
		segments_iter, info = asr_model.transcribe(
			audio,
			beam_size=1,
			word_timestamps=True,
			vad_filter=vad_filter,
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

	def transcribe_with_alignment(
		self,
		*,
		audio_bytes: bytes,
		config: TranscribeConfig,
	) -> dict[str, Any]:
		total_started_at = time.perf_counter()
		with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
			temp_file.write(audio_bytes)
			temp_path = Path(temp_file.name)

		try:
			timings_ms: dict[str, float] = {}

			# whisperx.load_audio normalizes to mono 16k via ffmpeg.
			load_audio_started_at = time.perf_counter()
			audio = whisperx.load_audio(str(temp_path))
			timings_ms["load_audio"] = (time.perf_counter() - load_audio_started_at) * 1000.0
			audio_duration_seconds = (
				max(0.0, float(len(audio)) / 16000.0)
				if hasattr(audio, "__len__")
				else 0.0
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
				)
				used_model = config.model
				used_compute = config.compute_type
			except RuntimeError:
				# OOM/compute fallback
				fallback_model = "medium" if config.model != "medium" else config.model
				fallback_compute = (
					"int8_float16" if used_device.startswith("cuda") else "int8"
				)
				asr_result = self._run_asr(
					audio=audio,
					model=fallback_model,
					device=used_device,
					compute_type=fallback_compute,
					vad_filter=config.vad_filter,
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
		finally:
			try:
				temp_path.unlink(missing_ok=True)
			except OSError:
				pass
			# Release transient allocations after each request.
			self._trim_caches()
