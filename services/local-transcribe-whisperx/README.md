# Local WhisperX Transcription Service

This service provides local word-level transcription and optional speaker diarization for OpenCut clip import.

## What it does

- Accepts uploaded clip audio (`wav` recommended).
- Runs local ASR with `faster-whisper`.
- Runs alignment with `whisperX`.
- Returns one timed word span per token.
- Can attach speaker labels when diarization is enabled and a Hugging Face token is configured.

## Endpoints

- `GET /healthz`
- `POST /v1/transcribe-word-timestamps`

`/healthz` reports runtime CUDA status (`cuda_available`, `cudnn_available`, `cuda_device_name`, `resolved_device`) so you can verify actual GPU execution, not just env config.

## Request (POST)

Multipart form:

- `file`: audio file
- `model` (optional): default `large-v3`
- `device` (optional): default `cuda`
- `compute_type` (optional): default `float16`
- `vad_filter` (optional): default `false` (set `true` to trim low-energy speech/noise)
- `language` (optional): requested language (ignored when `LOCAL_TRANSCRIBE_FORCE_PRIMARY_LANGUAGE=true`)
- `diarize` (optional): default `true`
- `min_speakers` / `max_speakers` (optional): diarization hints

Optional auth:

- `Authorization: Bearer <LOCAL_TRANSCRIBE_API_KEY>` when `LOCAL_TRANSCRIBE_API_KEY` is set.

## Response

```json
{
  "text": "full transcript",
  "words": [{ "word": "Hello", "start": 0.12, "end": 0.28, "speakerId": "SPEAKER_00" }],
  "segments": [{ "text": "Hello there", "start": 0.12, "end": 0.55, "speakerId": "SPEAKER_00" }],
  "language": "en",
  "model": "large-v3",
  "compute_type": "float16",
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
$env:LOCAL_TRANSCRIBE_MODEL="large-v3"
$env:LOCAL_TRANSCRIBE_DEVICE="cuda"
$env:LOCAL_TRANSCRIBE_COMPUTE_TYPE="float16"
$env:LOCAL_TRANSCRIBE_VAD_FILTER="false"
$env:LOCAL_TRANSCRIBE_PRIMARY_LANGUAGE="en"
$env:LOCAL_TRANSCRIBE_FORCE_PRIMARY_LANGUAGE="true"
$env:LOCAL_TRANSCRIBE_DIARIZATION="true"
$env:LOCAL_TRANSCRIBE_HF_TOKEN="your_huggingface_read_token"
$env:LOCAL_TRANSCRIBE_PREWARM="true"
uvicorn app:app --host 127.0.0.1 --port 8765
```

4. Validate:

```powershell
curl http://127.0.0.1:8765/healthz
```

## Notes

- The service does not downgrade to a smaller Whisper model on failure.
- Keep ffmpeg available on PATH for best audio compatibility.
- Keeping `LOCAL_TRANSCRIBE_VAD_FILTER=false` generally preserves short filler words like `uh`/`um` better.
- For tighter memory control in long sessions:
  - `LOCAL_TRANSCRIBE_MAX_MODEL_CACHE=1`
  - `LOCAL_TRANSCRIBE_MAX_ALIGN_CACHE=2`
- For single-GPU stability and predictable latency:
  - `LOCAL_TRANSCRIBE_MAX_CONCURRENCY=1`
- To fail fast when CUDA is not available:
  - `LOCAL_TRANSCRIBE_REQUIRE_CUDA=true`
- To lock English and skip language detection:
  - `LOCAL_TRANSCRIBE_PRIMARY_LANGUAGE=en`
  - `LOCAL_TRANSCRIBE_FORCE_PRIMARY_LANGUAGE=true`
- To prewarm ASR + align models on service boot:
  - `LOCAL_TRANSCRIBE_PREWARM=true`
- To enable diarization:
  - `LOCAL_TRANSCRIBE_DIARIZATION=true`
  - `LOCAL_TRANSCRIBE_HF_TOKEN=<hugging-face-read-token>`

## Docker GPU checks

```powershell
docker compose exec -T local-transcribe nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
docker compose exec -T local-transcribe python3 -c "import torch; print(torch.cuda.is_available(), torch.cuda.device_count(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'n/a')"
curl http://127.0.0.1:8765/healthz
```

## Docker diarization setup

Use the existing `local-transcribe` container and pass these env vars before rebuild/start:

```powershell
bun run docker:up
curl http://127.0.0.1:8765/healthz
```

Put these values in `apps/web/.env` before running the Docker helper:

```env
LOCAL_TRANSCRIBE_DIARIZATION=true
LOCAL_TRANSCRIBE_HF_TOKEN=hf_your_token_here
LOCAL_TRANSCRIBE_DIARIZATION_ENABLED=true
```

`bun run docker:up` now reads only `apps/web/.env`, so the web app and `local-transcribe` container stay in sync. `/healthz` should report `"diarization_enabled": true`.

Compose mounts a persistent cache volume (`local-transcribe-cache` -> `/root/.cache`) to avoid model/alignment redownloads across restarts.
