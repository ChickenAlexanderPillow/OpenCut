# Local WhisperX Transcription Service

This service provides local word-level transcription for OpenCut clip import.

## What it does

- Accepts uploaded clip audio (`wav` recommended).
- Runs local ASR with `faster-whisper`.
- Runs alignment with `whisperX`.
- Returns one timed word span per token.

## Endpoints

- `GET /healthz`
- `POST /v1/transcribe-word-timestamps`

## Request (POST)

Multipart form:

- `file`: audio file
- `model` (optional): default `medium`
- `device` (optional): default `cuda`
- `compute_type` (optional): default `int8_float16`
- `vad_filter` (optional): default `false` (set `true` to trim low-energy speech/noise)

Optional auth:

- `Authorization: Bearer <LOCAL_TRANSCRIBE_API_KEY>` when `LOCAL_TRANSCRIBE_API_KEY` is set.

## Response

```json
{
  "text": "full transcript",
  "words": [{ "word": "Hello", "start": 0.12, "end": 0.28 }],
  "language": "en",
  "model": "medium",
  "compute_type": "int8_float16",
  "engine": "whisperx"
}
```

## Windows (NVIDIA CUDA) setup

1. Create Python env (3.10 or 3.11 recommended).
2. Install deps:

```powershell
cd services/local-transcribe-whisperx
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements.txt
```

3. Run server:

```powershell
$env:LOCAL_TRANSCRIBE_MODEL="medium"
$env:LOCAL_TRANSCRIBE_DEVICE="cuda"
$env:LOCAL_TRANSCRIBE_COMPUTE_TYPE="int8_float16"
$env:LOCAL_TRANSCRIBE_VAD_FILTER="false"
uvicorn app:app --host 127.0.0.1 --port 8765
```

4. Validate:

```powershell
curl http://127.0.0.1:8765/healthz
```

## Notes

- On GPU OOM, service falls back to `medium` + `int8_float16`.
- Keep ffmpeg available on PATH for best audio compatibility.
- Keeping `LOCAL_TRANSCRIBE_VAD_FILTER=false` generally preserves short filler words like `uh`/`um` better.
- For tighter memory control in long sessions, set:
  - `LOCAL_TRANSCRIBE_MAX_MODEL_CACHE=1`
  - `LOCAL_TRANSCRIBE_MAX_ALIGN_CACHE=2`
