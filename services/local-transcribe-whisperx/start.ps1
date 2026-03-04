$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Test-Path ".venv")) {
	python -m venv .venv
}

. .\.venv\Scripts\Activate.ps1

python -m pip install --upgrade pip
python -m pip install -r requirements.txt

if (-not $env:LOCAL_TRANSCRIBE_MODEL) { $env:LOCAL_TRANSCRIBE_MODEL = "large-v3" }
if (-not $env:LOCAL_TRANSCRIBE_DEVICE) { $env:LOCAL_TRANSCRIBE_DEVICE = "cuda" }
if (-not $env:LOCAL_TRANSCRIBE_COMPUTE_TYPE) { $env:LOCAL_TRANSCRIBE_COMPUTE_TYPE = "float16" }
if (-not $env:LOCAL_TRANSCRIBE_VAD_FILTER) { $env:LOCAL_TRANSCRIBE_VAD_FILTER = "false" }

# Force CUDA-enabled torch wheels on Windows/NVIDIA setups.
if ($env:LOCAL_TRANSCRIBE_DEVICE -like "cuda*") {
	python -m pip install --upgrade --index-url https://download.pytorch.org/whl/cu128 torch==2.8.0+cu128 torchaudio==2.8.0+cu128
}

uvicorn app:app --host 127.0.0.1 --port 8765
