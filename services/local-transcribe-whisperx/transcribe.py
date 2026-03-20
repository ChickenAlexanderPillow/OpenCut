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
from whisperx.diarize import DiarizationPipeline, assign_word_speakers


@dataclass
class TranscribeConfig:
	model: str = "large-v3"
	device: str = "cuda"
	compute_type: str = "float16"
	vad_filter: bool = False
	language: str | None = None
	diarize: bool = False
	min_speakers: int | None = None
	max_speakers: int | None = None


class LocalWhisperXEngine:
	def __init__(self) -> None:
		self._max_model_cache = max(1, int(os.getenv("LOCAL_TRANSCRIBE_MAX_MODEL_CACHE", "1")))
		self._max_align_cache = max(1, int(os.getenv("LOCAL_TRANSCRIBE_MAX_ALIGN_CACHE", "2")))
		self._diarize_enabled = (
			os.getenv("LOCAL_TRANSCRIBE_DIARIZATION", "true").strip().lower()
			in {"1", "true", "yes", "on"}
		)
		self._hf_token = (os.getenv("LOCAL_TRANSCRIBE_HF_TOKEN") or "").strip() or None
		self._model_cache: "OrderedDict[tuple[str, str, str], WhisperModel]" = OrderedDict()
		self._align_cache: "OrderedDict[tuple[str, str], tuple[Any, Any]]" = OrderedDict()
		self._diarize_cache: "OrderedDict[str, Any]" = OrderedDict()

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
		while len(self._diarize_cache) > 1:
			self._diarize_cache.popitem(last=False)
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

	def _get_diarization_pipeline(self, *, device: str) -> Any | None:
		if not self._diarize_enabled or not self._hf_token:
			return None
		existing = self._diarize_cache.get(device)
		if existing:
			self._diarize_cache.move_to_end(device)
			return existing
		diarization = DiarizationPipeline(
			token=self._hf_token,
			device=device,
		)
		self._diarize_cache[device] = diarization
		self._trim_caches()
		return diarization

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
			"diarization_enabled": self._diarize_enabled and bool(self._hf_token),
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
			self._release_runtime_memory(clear_cuda_cache=used_device.startswith("cuda"))
			raise
		except Exception:
			raise
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
		diarization_started_at = time.perf_counter()
		speaker_segments: list[dict[str, Any]] = []
		diarization_used = False
		diarization_error: str | None = None
		if config.diarize:
			try:
				diarization = self._get_diarization_pipeline(device=used_device)
				if diarization is not None:
					diarize_segments = diarization(
						audio,
						min_speakers=config.min_speakers,
						max_speakers=config.max_speakers,
					)
					aligned = assign_word_speakers(diarize_segments, aligned)
					word_segments = aligned.get("word_segments", []) or []
					for segment in aligned.get("segments", []) or []:
						speaker_id = segment.get("speaker")
						start = segment.get("start")
						end = segment.get("end")
						text = (segment.get("text") or "").strip()
						if not speaker_id or start is None or end is None:
							continue
						start_f = max(0.0, float(start))
						end_f = max(start_f + 0.01, float(end))
						speaker_segments.append(
							{
								"text": text,
								"start": start_f,
								"end": end_f,
								"speakerId": str(speaker_id),
							}
						)
					diarization_used = True
				else:
					if not self._diarize_enabled:
						diarization_error = "Diarization is disabled by LOCAL_TRANSCRIBE_DIARIZATION"
					elif not self._hf_token:
						diarization_error = (
							"Diarization requested but no Hugging Face token was provided"
						)
			except Exception as error:
				diarization_used = False
				diarization_error = f"{type(error).__name__}: {error}"
		timings_ms["diarization"] = (time.perf_counter() - diarization_started_at) * 1000.0
		postprocess_started_at = time.perf_counter()
		words = []
		for item in word_segments:
			word = (item.get("word") or "").strip()
			start = item.get("start")
			end = item.get("end")
			speaker = item.get("speaker")
			if not word or start is None or end is None:
				continue
			start_f = max(0.0, float(start))
			end_f = max(start_f + 0.01, float(end))
			word_entry = {
				"word": word,
				"start": start_f,
				"end": end_f,
			}
			if speaker is not None and str(speaker).strip():
				word_entry["speakerId"] = str(speaker).strip()
			words.append(word_entry)
		timings_ms["postprocess"] = (time.perf_counter() - postprocess_started_at) * 1000.0
		total_ms = (time.perf_counter() - total_started_at) * 1000.0
		timings_ms["total"] = total_ms

		if config.diarize and not diarization_used and diarization_error:
			print(
				"Local transcribe diarization request failed",
				{
					"device": used_device,
					"model": used_model,
					"language": language,
					"error": diarization_error,
				},
				flush=True,
			)

		result = {
			"text": " ".join(segment.get("text", "").strip() for segment in asr_result["segments"]).strip(),
			"words": words,
			"segments": speaker_segments,
			"language": language,
			"model": used_model,
			"compute_type": used_compute,
			"device": used_device,
			"engine": "whisperx",
			"diarization": diarization_used,
			"timings_ms": timings_ms,
			"audio_duration_seconds": audio_duration_seconds,
			"word_count": len(words),
			"speaker_count": len({segment["speakerId"] for segment in speaker_segments}),
		}
		if diarization_error:
			result["diarization_error"] = diarization_error
		return result

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
