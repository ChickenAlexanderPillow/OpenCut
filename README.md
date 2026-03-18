<table width="100%">
  <tr>
    <td align="left" width="120">
      <img src="apps/web/public/logos/opencut/1k/logo-white-black.png" alt="OpenCut Logo" width="100" />
    </td>
    <td align="right">
      <h1>OpenCut</span></h1>
      <h3 style="margin-top: -10px;">A free, open-source video editor for web, desktop, and mobile.</h3>
    </td>
  </tr>
</table>

## Sponsors

Thanks to [Vercel](https://vercel.com?utm_source=github-opencut&utm_campaign=oss) and [fal.ai](https://fal.ai?utm_source=github-opencut&utm_campaign=oss) for their support of open-source software.

<a href="https://vercel.com/oss">
  <img alt="Vercel OSS Program" src="https://vercel.com/oss/program-badge.svg" />
</a>

<a href="https://fal.ai">
  <img alt="Powered by fal.ai" src="https://img.shields.io/badge/Powered%20by-fal.ai-000000?style=flat&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJMMTMuMDkgOC4yNkwyMCAxMEwxMy4wOSAxNS43NEwxMiAyMkwxMC45MSAxNS43NEw0IDEwTDEwLjkxIDguMjZMMTIgMloiIGZpbGw9IndoaXRlIi8+Cjwvc3ZnPgo=" />
</a>

## Why?

- **Privacy**: Your videos stay on your device
- **Free features**: Most basic CapCut features are now paywalled 
- **Simple**: People want editors that are easy to use - CapCut proved that

## Features

- Timeline-based editing
- Multi-track support
- Real-time preview
- No watermarks or subscriptions
- Analytics provided by [Databuddy](https://www.databuddy.cc?utm_source=opencut), 100% Anonymized & Non-invasive.
- Blog powered by [Marble](https://marblecms.com?utm_source=opencut), Headless CMS.

## Project Structure

- `apps/web/` – Main Next.js web application
- `src/components/` – UI and editor components
- `src/hooks/` – Custom React hooks
- `src/lib/` – Utility and API logic
- `src/stores/` – State management (Zustand, etc.)
- `src/types/` – TypeScript types

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/docs/installation)
- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)

> **Note:** Docker is optional but recommended for running local Redis and transcription sidecars. If you only want to work on frontend features, you can skip it.

### Setup

1. Fork and clone the repository

2. Copy the environment file:

   ```bash
   # Unix/Linux/Mac
   cp apps/web/.env.example apps/web/.env.local

   # Windows PowerShell
   Copy-Item apps/web/.env.example apps/web/.env.local
   ```

3. Start Redis:

   ```bash
   docker compose up -d redis serverless-redis-http
   ```

4. Install dependencies and start the dev server:

   ```bash
   bun install
   bun dev:web
   ```

   Lower-memory option for WSL users:

   ```bash
   bun run dev:web:low-mem
   ```

   Memory audit and reduction (Windows PowerShell):

   ```bash
   bun run mem:audit
   bun run mem:reduce
   # Aggressive mode: also force-closes Chrome and shuts down Docker Desktop/WSL
   bun run mem:reduce:aggressive
   ```

The application will be available at [http://localhost:3000](http://localhost:3000).

The `.env.example` has sensible defaults that match the Docker Compose config — it should work out of the box.

### Self-Hosting with Docker

To run everything (including a production build of the app) in Docker:

```bash
docker compose up -d
```

The app will be available at [http://localhost:3000](http://localhost:3000).

For this repo, the Docker helpers are:

```bash
bun run docker:up
```

Starts the full stack when an NVIDIA GPU is available. If not, it automatically starts the web stack without `local-transcribe` instead of failing the whole bring-up.

Lower-memory Docker option (skips `local-transcribe`):

```bash
bun run docker:up:core
```

Web-only shortcut (rebuilds/starts `web` without stopping an already-running `local-transcribe`):

```bash
bun run docker:up:web
```

Transcription quality/memory tuning (Docker env overrides):

```bash
# Higher quality, higher memory
LOCAL_TRANSCRIBE_MODEL=large-v3 LOCAL_TRANSCRIBE_COMPUTE_TYPE=float16 bun run docker:up

# Lower memory (default in this repo)
LOCAL_TRANSCRIBE_MODEL=medium LOCAL_TRANSCRIBE_COMPUTE_TYPE=int8_float16 bun run docker:up

# Enforce GPU-only transcription (default true in docker-compose.yml)
LOCAL_TRANSCRIBE_REQUIRE_CUDA=true bun run docker:up

# Keep queueing predictable on a single GPU
LOCAL_TRANSCRIBE_MAX_CONCURRENCY=1 bun run docker:up

# Lock transcription/alignment to English and prewarm at startup
LOCAL_TRANSCRIBE_PRIMARY_LANGUAGE=en LOCAL_TRANSCRIBE_FORCE_PRIMARY_LANGUAGE=true LOCAL_TRANSCRIBE_PREWARM=true bun run docker:up
```

Verify local-transcribe is actually running on GPU:

```bash
docker compose exec -T local-transcribe nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
docker compose exec -T local-transcribe python3 -c "import torch; print('cuda_available=', torch.cuda.is_available()); print('device_count=', torch.cuda.device_count()); print('device_name=', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'n/a')"
curl http://127.0.0.1:8765/healthz
```

`local-transcribe` now uses a named Docker volume (`local-transcribe-cache`) for model/cache persistence so repeated restarts avoid re-downloading alignment/model artifacts.

To stop it:

```bash
bun run docker:down
```

### WSL Memory Cap (Windows)

If `vmmemwsl` keeps growing, set a hard memory cap for WSL in `%UserProfile%\.wslconfig`:

```ini
[wsl2]
memory=8GB
processors=6
swap=2GB
```

Apply it with:

```powershell
wsl --shutdown
```

## Contributing

We welcome contributions! While we're actively developing and refactoring certain areas, there are plenty of opportunities to contribute effectively.

**🎯 Focus areas:** Timeline functionality, project management, performance, bug fixes, and UI improvements outside the preview panel.

**⚠️ Avoid for now:** Preview panel enhancements (fonts, stickers, effects) and export functionality - we're refactoring these with a new binary rendering approach.

See our [Contributing Guide](.github/CONTRIBUTING.md) for detailed setup instructions, development guidelines, and complete focus area guidance.

**Quick start for contributors:**

- Fork the repo and clone locally
- Follow the setup instructions in CONTRIBUTING.md
- Create a feature branch and submit a PR

## License

[MIT LICENSE](LICENSE)

---

![Star History Chart](https://api.star-history.com/svg?repos=opencut-app/opencut&type=Date)
