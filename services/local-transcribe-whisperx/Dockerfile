FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
	python3 \
	python3-pip \
	ffmpeg \
	ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/local-transcribe-whisperx/requirements.txt /app/requirements.txt

# whisperx==3.8.1 expects torch~=2.8.0; install CUDA build explicitly.
RUN python3 -m pip install --upgrade pip && \
	python3 -m pip install --index-url https://download.pytorch.org/whl/cu128 \
		torch==2.8.0+cu128 torchaudio==2.8.0+cu128 && \
	python3 -m pip install -r /app/requirements.txt

COPY services/local-transcribe-whisperx/app.py /app/app.py
COPY services/local-transcribe-whisperx/transcribe.py /app/transcribe.py

EXPOSE 8765

CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8765"]
