from __future__ import annotations

import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel
import torch
import whisperx


@dataclass
class TranscribeConfig:
	model: str = "large-v3"
	device: str = "cuda"
	compute_type: str = "float16"
	batch_size: int = 16


class LocalWhisperXEngine:
	def __init__(self) -> None:
		self._model_cache: dict[tuple[str, str, str], WhisperModel] = {}
		self._align_cache: dict[tuple[str, str], tuple[Any, Any]] = {}

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
			return existing
		asr_model = WhisperModel(model, device=device, compute_type=compute_type)
		self._model_cache[key] = asr_model
		return asr_model

	def _get_align_model(self, *, language: str, device: str) -> tuple[Any, Any]:
		key = (language, device)
		existing = self._align_cache.get(key)
		if existing:
			return existing
		align_model, metadata = whisperx.load_align_model(
			language_code=language,
			device=device,
		)
		self._align_cache[key] = (align_model, metadata)
		return align_model, metadata

	def _run_asr(
		self,
		*,
		audio: Any,
		model: str,
		device: str,
		compute_type: str,
	) -> dict[str, Any]:
		asr_model = self._get_asr_model(
			model=model,
			device=device,
			compute_type=compute_type,
		)
		segments_iter, info = asr_model.transcribe(
			audio,
			beam_size=5,
			word_timestamps=True,
			vad_filter=True,
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
		with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
			temp_file.write(audio_bytes)
			temp_path = Path(temp_file.name)

		try:
			# whisperx.load_audio normalizes to mono 16k via ffmpeg.
			audio = whisperx.load_audio(str(temp_path))
			used_device = self._resolve_device(config.device)
			try:
				asr_result = self._run_asr(
					audio=audio,
					model=config.model,
					device=used_device,
					compute_type=config.compute_type,
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
				)
				used_model = fallback_model
				used_compute = fallback_compute

			language = asr_result["language"] or "en"
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
			word_segments = aligned.get("word_segments", []) or []
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

			return {
				"text": " ".join(segment.get("text", "").strip() for segment in asr_result["segments"]).strip(),
				"words": words,
				"language": language,
				"model": used_model,
				"compute_type": used_compute,
				"device": used_device,
				"engine": "whisperx",
			}
		finally:
			try:
				temp_path.unlink(missing_ok=True)
			except OSError:
				pass
