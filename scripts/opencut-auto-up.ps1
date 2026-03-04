$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Test-DockerReady {
	try {
		$null = docker version --format "{{.Server.APIVersion}}" 2>$null
		return $LASTEXITCODE -eq 0
	} catch {
		return $false
	}
}

# Wait for Docker Desktop engine to become ready after login.
$maxAttempts = 60
for ($i = 0; $i -lt $maxAttempts; $i++) {
	if (Test-DockerReady) {
		break
	}
	Start-Sleep -Seconds 5
}

if (-not (Test-DockerReady)) {
	Write-Error "Docker engine not ready after waiting."
	exit 1
}

docker compose up -d redis serverless-redis-http local-transcribe web
