from __future__ import annotations

import os
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Header, UploadFile
from fastapi.responses import JSONResponse
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

app = FastAPI(title="local-whisperx-transcribe", version="1.0.0")
engine = LocalWhisperXEngine()


class HealthResponse(BaseModel):
	status: str
	engine: str
	device: str
	default_model: str
	default_compute_type: str
	default_vad_filter: bool


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


@app.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
	return HealthResponse(
		status="ok",
		engine="whisperx",
		device=os.getenv("LOCAL_TRANSCRIBE_DEVICE", "cuda"),
		default_model=os.getenv("LOCAL_TRANSCRIBE_MODEL", "medium"),
		default_compute_type=os.getenv("LOCAL_TRANSCRIBE_COMPUTE_TYPE", "int8_float16"),
		default_vad_filter=_parse_bool(
			os.getenv("LOCAL_TRANSCRIBE_VAD_FILTER"),
			False,
		),
	)


@app.post("/v1/transcribe-word-timestamps")
async def transcribe_word_timestamps(
	file: UploadFile = File(...),
	model: Optional[str] = Form(default=None),
	device: Optional[str] = Form(default=None),
	compute_type: Optional[str] = Form(default=None),
	vad_filter: Optional[str] = Form(default=None),
	authorization: Optional[str] = Header(default=None),
) -> JSONResponse:
	_require_auth(authorization)

	if not file.filename:
		raise HTTPException(status_code=400, detail="file is required")

	audio_bytes = await file.read()
	if len(audio_bytes) == 0 or len(audio_bytes) > MAX_UPLOAD_BYTES:
		raise HTTPException(status_code=400, detail="Invalid file size")

	config = TranscribeConfig(
		model=(model or os.getenv("LOCAL_TRANSCRIBE_MODEL", "medium")).strip(),
		device=(device or os.getenv("LOCAL_TRANSCRIBE_DEVICE", "cuda")).strip(),
		compute_type=(
			compute_type or os.getenv("LOCAL_TRANSCRIBE_COMPUTE_TYPE", "int8_float16")
		).strip(),
		vad_filter=_parse_bool(
			vad_filter,
			_parse_bool(os.getenv("LOCAL_TRANSCRIBE_VAD_FILTER"), False),
		),
	)

	try:
		result = engine.transcribe_with_alignment(
			audio_bytes=audio_bytes,
			config=config,
		)
	except Exception as error:
		raise HTTPException(status_code=500, detail=str(error)) from error

	if not result.get("words"):
		raise HTTPException(
			status_code=422,
			detail="No word-level timestamps were produced",
		)

	return JSONResponse(content=result)
