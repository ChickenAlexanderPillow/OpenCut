from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import tempfile
import time
import traceback
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Header, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

# Ensure CUDA/cuDNN DLLs bundled with torch are discoverable on Windows
# before importing modules that load ctranslate2/whisper runtimes.
def _configure_windows_torch_dlls() -> None:
	if os.name != "nt":
		return
	try:
		import site
	except Exception:
		return

	candidate_roots = []
	try:
		candidate_roots.extend(site.getsitepackages())
	except Exception:
		pass
	try:
		candidate_roots.append(site.getusersitepackages())
	except Exception:
		pass

	for root in candidate_roots:
		torch_lib = os.path.join(root, "torch", "lib")
		if not os.path.isdir(torch_lib):
			continue
		try:
			os.add_dll_directory(torch_lib)
		except Exception:
			pass
		os.environ["PATH"] = f"{torch_lib};{os.environ.get('PATH', '')}"
		break


_configure_windows_torch_dlls()

from transcribe import LocalWhisperXEngine, TranscribeConfig


MAX_UPLOAD_BYTES = 20 * 1024 * 1024
TRANSCODE_MAX_UPLOAD_BYTES = int(
	os.getenv("LOCAL_TRANSCODE_MAX_UPLOAD_BYTES", str(20 * 1024 * 1024 * 1024))
)
TRANSCRIBE_MAX_CONCURRENCY = max(
	1,
	int(os.getenv("LOCAL_TRANSCRIBE_MAX_CONCURRENCY", "1")),
)
TRANSCRIBE_PRIMARY_LANGUAGE = (
	os.getenv("LOCAL_TRANSCRIBE_PRIMARY_LANGUAGE", "en").strip().lower() or "en"
)
IMPORT_TRANSCODE_PROFILE = "chrome-h264-aac-1080p30"
IMPORT_AUDIO_BITRATE = 192_000
IMPORT_VIDEO_MAX_FPS = 30

app = FastAPI(title="local-whisperx-transcribe", version="1.0.0")
logger = logging.getLogger("local_transcribe")
cors_origins = [
	origin.strip()
	for origin in (
		os.getenv(
			"LOCAL_TRANSCRIBE_CORS_ORIGINS",
			"http://localhost:3000,http://127.0.0.1:3000",
		)
	).split(",")
	if origin.strip()
]
app.add_middleware(
	CORSMiddleware,
	allow_origins=cors_origins if cors_origins else ["*"],
	allow_credentials=False,
	allow_methods=["*"],
	allow_headers=["*"],
	expose_headers=[
		"x-import-transcoded",
		"x-import-transcode-profile",
		"x-import-video-bitrate",
		"x-import-audio-bitrate",
		"x-import-target-fps",
		"x-output-filename",
		"x-video-encoder",
	],
)
engine = LocalWhisperXEngine()
transcribe_semaphore = asyncio.Semaphore(TRANSCRIBE_MAX_CONCURRENCY)


class HealthResponse(BaseModel):
	status: str
	engine: str
	requested_device: str
	resolved_device: str
	cuda_available: bool
	cudnn_available: bool
	cuda_device_count: int
	cuda_device_name: Optional[str]
	require_cuda: bool
	gpu_ready: bool
	default_model: str
	default_compute_type: str
	default_vad_filter: bool
	primary_language: str
	force_primary_language: bool
	diarization_enabled: bool


def _is_cuda_requested(device: str) -> bool:
	return (device or "").strip().lower().startswith("cuda")


def _is_gpu_ready(runtime: dict[str, object]) -> bool:
	return bool(
		runtime.get("cuda_available")
		and runtime.get("cudnn_available")
		and int(runtime.get("cuda_device_count") or 0) > 0
	)


def _require_cuda_enabled() -> bool:
	return _parse_bool(os.getenv("LOCAL_TRANSCRIBE_REQUIRE_CUDA"), False)


def _force_primary_language() -> bool:
	return _parse_bool(os.getenv("LOCAL_TRANSCRIBE_FORCE_PRIMARY_LANGUAGE"), True)


def _prewarm_enabled() -> bool:
	return _parse_bool(os.getenv("LOCAL_TRANSCRIBE_PREWARM"), True)


def _require_auth(authorization: Optional[str]) -> None:
	expected = (os.getenv("LOCAL_TRANSCRIBE_API_KEY") or "").strip()
	if not expected:
		return
	if not authorization or not authorization.startswith("Bearer "):
		raise HTTPException(status_code=401, detail="Unauthorized")
	token = authorization[len("Bearer ") :].strip()
	if token != expected:
		raise HTTPException(status_code=401, detail="Unauthorized")


def _parse_bool(value: Optional[str], default: bool) -> bool:
	if value is None:
		return default
	normalized = value.strip().lower()
	if normalized in {"1", "true", "yes", "on"}:
		return True
	if normalized in {"0", "false", "no", "off"}:
		return False
	return default


def _parse_optional_int(value: Optional[str]) -> Optional[int]:
	if value is None:
		return None
	normalized = value.strip()
	if not normalized:
		return None
	try:
		return int(float(normalized))
	except Exception:
		return None


def _normalize_target_fps(source_fps: Optional[int]) -> int:
	if source_fps is None or source_fps <= 0:
		return IMPORT_VIDEO_MAX_FPS
	return max(1, min(IMPORT_VIDEO_MAX_FPS, int(round(source_fps))))


def _select_video_bitrate(source_width: Optional[int], source_height: Optional[int]) -> int:
	if (
		source_width is None
		or source_height is None
		or source_width <= 0
		or source_height <= 0
	):
		return 5_000_000
	long_edge = max(source_width, source_height)
	if long_edge <= 854:
		return 1_800_000
	if long_edge <= 1280:
		return 3_000_000
	return 5_000_000


def _ffmpeg_output_name(input_name: str, media_type: str) -> str:
	base = Path(input_name).name
	if media_type == "video":
		return f"{base}.transcoded.mp4"
	return f"{base}.transcoded.m4a"


def _build_video_ffmpeg_args(
	input_arg: str,
	output_path: Path,
	source_width: Optional[int],
	source_height: Optional[int],
	source_fps: Optional[int],
) -> tuple[list[str], int, int]:
	video_bitrate = _select_video_bitrate(source_width, source_height)
	target_fps = _normalize_target_fps(source_fps)
	maxrate = int(round(video_bitrate * 1.3))
	bufsize = int(round(video_bitrate * 2))
	scale_filter = (
		"scale_cuda=w=1080:h=1080:"
		"force_original_aspect_ratio=decrease:"
		"force_divisible_by=2"
	)

	args = [
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-hwaccel",
		"cuda",
		"-hwaccel_output_format",
		"cuda",
		"-i",
		input_arg,
		"-map",
		"0:v:0",
		"-map",
		"0:a:0?",
		"-vf",
		scale_filter,
		"-r",
		str(target_fps),
		"-b:v",
		str(video_bitrate),
		"-maxrate",
		str(maxrate),
		"-bufsize",
		str(bufsize),
		"-c:a",
		"aac",
		"-b:a",
		"192k",
		"-ar",
		"48000",
		"-ac",
		"2",
		"-movflags",
		"+faststart",
		"-c:v",
		"h264_nvenc",
		"-preset",
		"p1",
		"-profile:v",
		"high",
		"-level:v",
		"4.1",
		"-rc:v",
		"vbr",
		str(output_path),
	]

	return args, video_bitrate, target_fps


def _build_audio_ffmpeg_args(input_arg: str, output_path: Path) -> list[str]:
	return [
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		input_arg,
		"-map",
		"0:a:0",
		"-c:a",
		"aac",
		"-b:a",
		"192k",
		"-ar",
		"48000",
		"-ac",
		"2",
		"-movflags",
		"+faststart",
		str(output_path),
	]


async def _transcode_stream_to_output(
	file: UploadFile,
	output_path: Path,
	max_bytes: int,
	command: list[str],
) -> int:
	process = subprocess.Popen(
		command,
		stdin=subprocess.PIPE,
		stdout=subprocess.DEVNULL,
		stderr=subprocess.PIPE,
	)
	total_bytes = 0
	try:
		if process.stdin is None:
			raise RuntimeError("Failed to open ffmpeg stdin")

		while True:
			chunk = await file.read(8 * 1024 * 1024)
			if not chunk:
				break
			total_bytes += len(chunk)
			if total_bytes > max_bytes:
				raise HTTPException(status_code=400, detail="Invalid file size")
			process.stdin.write(chunk)

		process.stdin.close()
		stderr = (process.stderr.read() if process.stderr else b"").decode(
			"utf-8",
			errors="ignore",
		).strip()
		return_code = process.wait()
		if return_code != 0:
			raise RuntimeError(stderr or "Unknown ffmpeg transcode error")
		return total_bytes
	except Exception:
		process.kill()
		raise


async def _write_request_stream_to_file(
	request: Request,
	output_path: Path,
	max_bytes: int,
) -> int:
	total_bytes = 0
	with output_path.open("wb") as output_handle:
		async for chunk in request.stream():
			if not chunk:
				continue
			total_bytes += len(chunk)
			if total_bytes > max_bytes:
				raise HTTPException(status_code=400, detail="Invalid file size")
			output_handle.write(chunk)
	return total_bytes


def _run_ffmpeg_command(command: list[str]) -> None:
	process = subprocess.run(
		command,
		stdout=subprocess.DEVNULL,
		stderr=subprocess.PIPE,
		check=False,
	)
	if process.returncode != 0:
		stderr = (process.stderr or b"").decode("utf-8", errors="ignore").strip()
		raise RuntimeError(stderr or "Unknown ffmpeg transcode error")


@app.on_event("startup")
async def _prewarm_transcription_models() -> None:
	if not _prewarm_enabled():
		return
	model = os.getenv("LOCAL_TRANSCRIBE_MODEL", "large-v2").strip() or "large-v2"
	device = os.getenv("LOCAL_TRANSCRIBE_DEVICE", "cuda").strip() or "cuda"
	compute_type = (
		os.getenv("LOCAL_TRANSCRIBE_COMPUTE_TYPE", "float16").strip()
		or "float16"
	)
	try:
		info = await asyncio.to_thread(
			engine.prewarm,
			model=model,
			device=device,
			compute_type=compute_type,
			language=TRANSCRIBE_PRIMARY_LANGUAGE,
		)
		print("Local transcribe prewarm complete", info, flush=True)
		runtime = engine.get_runtime_device_info()
		print(
			"Local transcribe diarization",
			{
				"enabled": bool(runtime.get("diarization_enabled")),
				"requested": _parse_bool(
					os.getenv("LOCAL_TRANSCRIBE_DIARIZATION"),
					True,
				),
				"has_hf_token": bool(
					(os.getenv("LOCAL_TRANSCRIBE_HF_TOKEN") or "").strip()
				),
			},
			flush=True,
		)
	except Exception as error:
		print(f"Local transcribe prewarm skipped: {error}", flush=True)


async def _write_upload_file_to_temp(file: UploadFile, max_bytes: int) -> tuple[Path, int]:
	suffix = Path(file.filename).suffix if file.filename else ""
	if not suffix:
		suffix = ".bin"
	total_bytes = 0
	temp_path: Path | None = None
	try:
		with tempfile.NamedTemporaryFile(
			prefix="opencut-transcribe-",
			suffix=suffix,
			delete=False,
		) as temp_file:
			temp_path = Path(temp_file.name)
			while True:
				chunk = await file.read(8 * 1024 * 1024)
				if not chunk:
					break
				total_bytes += len(chunk)
				if total_bytes > max_bytes:
					raise HTTPException(status_code=400, detail="Invalid file size")
				temp_file.write(chunk)
		if total_bytes <= 0:
			raise HTTPException(status_code=400, detail="Invalid file size")
		return temp_path, total_bytes
	except Exception:
		if temp_path is not None:
			try:
				temp_path.unlink(missing_ok=True)
			except OSError:
				pass
		raise


@app.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
	requested_device = os.getenv("LOCAL_TRANSCRIBE_DEVICE", "cuda").strip() or "cuda"
	require_cuda = _require_cuda_enabled()
	runtime = engine.get_runtime_device_info()
	gpu_ready = _is_gpu_ready(runtime)
	resolved_device = "cuda" if _is_cuda_requested(requested_device) and gpu_ready else "cpu"
	if require_cuda and _is_cuda_requested(requested_device) and resolved_device != "cuda":
		raise HTTPException(
			status_code=503,
			detail="CUDA was requested but is not available inside local-transcribe",
		)
	return HealthResponse(
		status="ok",
		engine="whisperx",
		requested_device=requested_device,
		resolved_device=resolved_device,
		cuda_available=bool(runtime.get("cuda_available")),
		cudnn_available=bool(runtime.get("cudnn_available")),
		cuda_device_count=int(runtime.get("cuda_device_count") or 0),
		cuda_device_name=(
			str(runtime["cuda_device_name"])
			if runtime.get("cuda_device_name")
			else None
		),
		require_cuda=require_cuda,
		gpu_ready=gpu_ready,
		default_model=os.getenv("LOCAL_TRANSCRIBE_MODEL", "large-v2"),
		default_compute_type=os.getenv("LOCAL_TRANSCRIBE_COMPUTE_TYPE", "float16"),
		default_vad_filter=_parse_bool(
			os.getenv("LOCAL_TRANSCRIBE_VAD_FILTER"),
			False,
		),
		primary_language=TRANSCRIBE_PRIMARY_LANGUAGE,
		force_primary_language=_force_primary_language(),
		diarization_enabled=bool(runtime.get("diarization_enabled")),
	)


@app.post("/v1/transcribe-word-timestamps")
async def transcribe_word_timestamps(
	file: UploadFile = File(...),
	model: Optional[str] = Form(default=None),
	device: Optional[str] = Form(default=None),
	compute_type: Optional[str] = Form(default=None),
	vad_filter: Optional[str] = Form(default=None),
	language: Optional[str] = Form(default=None),
	initial_prompt: Optional[str] = Form(default=None),
	diarize: Optional[str] = Form(default=None),
	min_speakers: Optional[str] = Form(default=None),
	max_speakers: Optional[str] = Form(default=None),
	authorization: Optional[str] = Header(default=None),
) -> JSONResponse:
	_require_auth(authorization)

	if not file.filename:
		raise HTTPException(status_code=400, detail="file is required")

	requested_language = (language or "").strip().lower() or None
	effective_language = (
		TRANSCRIBE_PRIMARY_LANGUAGE if _force_primary_language() else requested_language
	)

	config = TranscribeConfig(
		model=(model or os.getenv("LOCAL_TRANSCRIBE_MODEL", "large-v2")).strip(),
		device=(device or os.getenv("LOCAL_TRANSCRIBE_DEVICE", "cuda")).strip(),
		compute_type=(
			compute_type or os.getenv("LOCAL_TRANSCRIBE_COMPUTE_TYPE", "float16")
		).strip(),
		vad_filter=_parse_bool(
			vad_filter,
			_parse_bool(os.getenv("LOCAL_TRANSCRIBE_VAD_FILTER"), False),
		),
		language=effective_language,
		initial_prompt=(initial_prompt or os.getenv("LOCAL_TRANSCRIBE_INITIAL_PROMPT", "")).strip()
		or None,
		diarize=_parse_bool(
			diarize,
			_parse_bool(os.getenv("LOCAL_TRANSCRIBE_DIARIZATION"), True),
		),
		min_speakers=_parse_optional_int(min_speakers),
		max_speakers=_parse_optional_int(max_speakers),
	)

	require_cuda = _require_cuda_enabled()
	if require_cuda and _is_cuda_requested(config.device):
		runtime = engine.get_runtime_device_info()
		if not _is_gpu_ready(runtime):
			raise HTTPException(
				status_code=503,
				detail="CUDA was requested but is not available inside local-transcribe",
			)

	temp_path, _ = await _write_upload_file_to_temp(file=file, max_bytes=MAX_UPLOAD_BYTES)
	try:
		queued_at = time.perf_counter()
		async with transcribe_semaphore:
			queue_wait_ms = (time.perf_counter() - queued_at) * 1000.0
			result = await asyncio.to_thread(
				engine.transcribe_file_with_alignment,
				audio_path=temp_path,
				config=config,
			)
			timings = result.get("timings_ms")
			if isinstance(timings, dict):
				timings["queue_wait"] = max(0.0, queue_wait_ms)
			else:
				result["timings_ms"] = {"queue_wait": max(0.0, queue_wait_ms)}
	except Exception as error:
		logger.exception("Local transcription request failed")
		print(
			"Local transcription request failed",
			{
				"file": file.filename,
				"model": config.model,
				"device": config.device,
				"language": config.language,
				"diarize": config.diarize,
				"traceback": traceback.format_exc(),
			},
			flush=True,
		)
		raise HTTPException(status_code=500, detail=str(error)) from error
	finally:
		try:
			temp_path.unlink(missing_ok=True)
		except OSError:
			pass

	if not result.get("words"):
		raise HTTPException(
			status_code=422,
			detail="No word-level timestamps were produced",
		)

	return JSONResponse(content=result)


@app.post("/v1/transcode-import")
async def transcode_import(
	file: UploadFile = File(...),
	media_type: str = Form(...),
	source_width: Optional[str] = Form(default=None),
	source_height: Optional[str] = Form(default=None),
	source_fps: Optional[str] = Form(default=None),
	authorization: Optional[str] = Header(default=None),
) -> Response:
	_require_auth(authorization)

	if media_type not in {"video", "audio"}:
		raise HTTPException(status_code=400, detail="media_type must be video or audio")
	if not file.filename:
		raise HTTPException(status_code=400, detail="file is required")

	src_width = _parse_optional_int(source_width)
	src_height = _parse_optional_int(source_height)
	src_fps = _parse_optional_int(source_fps)

	with tempfile.TemporaryDirectory(prefix="opencut-transcode-") as temp_dir:
		temp_path = Path(temp_dir)
		output_path = temp_path / ("output.mp4" if media_type == "video" else "output.m4a")

		try:
			video_bitrate: Optional[int] = None
			target_fps: Optional[int] = None
			video_encoder = ""
			if media_type == "video":
				video_args, video_bitrate, target_fps = _build_video_ffmpeg_args(
					input_arg="pipe:0",
					output_path=output_path,
					source_width=src_width,
					source_height=src_height,
					source_fps=src_fps,
				)
				total_bytes = await _transcode_stream_to_output(
					file=file,
					output_path=output_path,
					max_bytes=TRANSCODE_MAX_UPLOAD_BYTES,
					command=video_args,
				)
				video_encoder = "h264_nvenc"
			else:
				audio_args = _build_audio_ffmpeg_args(
					input_arg="pipe:0",
					output_path=output_path,
				)
				total_bytes = await _transcode_stream_to_output(
					file=file,
					output_path=output_path,
					max_bytes=TRANSCODE_MAX_UPLOAD_BYTES,
					command=audio_args,
				)
			if total_bytes <= 0:
				raise HTTPException(status_code=400, detail="Invalid file size")
		except RuntimeError as error:
			raise HTTPException(status_code=500, detail=str(error)) from error
		except Exception as error:
			raise HTTPException(status_code=500, detail=f"Transcoding failed: {error}") from error

		if not output_path.exists() or output_path.stat().st_size <= 0:
			raise HTTPException(status_code=500, detail="Transcoding produced no output")

		body = output_path.read_bytes()
		headers = {
			"x-import-transcoded": "true",
			"x-import-transcode-profile": IMPORT_TRANSCODE_PROFILE,
			"x-import-audio-bitrate": str(IMPORT_AUDIO_BITRATE),
			"x-output-filename": _ffmpeg_output_name(file.filename, media_type),
			"x-video-encoder": video_encoder,
		}
		if video_bitrate is not None:
			headers["x-import-video-bitrate"] = str(video_bitrate)
		if target_fps is not None:
			headers["x-import-target-fps"] = str(target_fps)

		return Response(
			content=body,
			media_type="video/mp4" if media_type == "video" else "audio/mp4",
			headers=headers,
		)


@app.post("/v1/transcode-import-stream")
async def transcode_import_stream(
	request: Request,
	media_type: str = Header(..., alias="x-media-type"),
	source_width: Optional[str] = Header(default=None, alias="x-source-width"),
	source_height: Optional[str] = Header(default=None, alias="x-source-height"),
	source_fps: Optional[str] = Header(default=None, alias="x-source-fps"),
	file_name: Optional[str] = Header(default=None, alias="x-file-name"),
	authorization: Optional[str] = Header(default=None),
) -> Response:
	_require_auth(authorization)

	if media_type not in {"video", "audio"}:
		raise HTTPException(status_code=400, detail="x-media-type must be video or audio")

	src_width = _parse_optional_int(source_width)
	src_height = _parse_optional_int(source_height)
	src_fps = _parse_optional_int(source_fps)
	effective_name = file_name.strip() if file_name and file_name.strip() else "import-media"

	with tempfile.TemporaryDirectory(prefix="opencut-transcode-stream-") as temp_dir:
		temp_path = Path(temp_dir)
		input_suffix = Path(effective_name).suffix if Path(effective_name).suffix else ".bin"
		input_path = temp_path / f"input{input_suffix}"
		output_path = temp_path / ("output.mp4" if media_type == "video" else "output.m4a")

		try:
			total_bytes = await _write_request_stream_to_file(
				request=request,
				output_path=input_path,
				max_bytes=TRANSCODE_MAX_UPLOAD_BYTES,
			)
			if total_bytes <= 0:
				raise HTTPException(status_code=400, detail="Invalid file size")

			video_bitrate: Optional[int] = None
			target_fps: Optional[int] = None
			video_encoder = ""
			if media_type == "video":
				video_args, video_bitrate, target_fps = _build_video_ffmpeg_args(
					input_arg=str(input_path),
					output_path=output_path,
					source_width=src_width,
					source_height=src_height,
					source_fps=src_fps,
				)
				_run_ffmpeg_command(video_args)
				video_encoder = "h264_nvenc"
			else:
				audio_args = _build_audio_ffmpeg_args(
					input_arg=str(input_path),
					output_path=output_path,
				)
				_run_ffmpeg_command(audio_args)
		except RuntimeError as error:
			raise HTTPException(status_code=500, detail=str(error)) from error
		except Exception as error:
			raise HTTPException(status_code=500, detail=f"Transcoding failed: {error}") from error

		if not output_path.exists() or output_path.stat().st_size <= 0:
			raise HTTPException(status_code=500, detail="Transcoding produced no output")

		body = output_path.read_bytes()
		headers = {
			"x-import-transcoded": "true",
			"x-import-transcode-profile": IMPORT_TRANSCODE_PROFILE,
			"x-import-audio-bitrate": str(IMPORT_AUDIO_BITRATE),
			"x-output-filename": _ffmpeg_output_name(effective_name, media_type),
			"x-video-encoder": video_encoder,
		}
		if video_bitrate is not None:
			headers["x-import-video-bitrate"] = str(video_bitrate)
		if target_fps is not None:
			headers["x-import-target-fps"] = str(target_fps)

		return Response(
			content=body,
			media_type="video/mp4" if media_type == "video" else "audio/mp4",
			headers=headers,
		)
