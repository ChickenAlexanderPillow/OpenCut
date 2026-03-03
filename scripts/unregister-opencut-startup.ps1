$ErrorActionPreference = "Stop"

$taskName = "OpenCutDockerAutoStart"
$startupDir = [Environment]::GetFolderPath("Startup")
$startupVbsPath = Join-Path $startupDir "OpenCutDockerAutoStart.vbs"

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
if (Test-Path $startupVbsPath) {
	Remove-Item -Path $startupVbsPath -Force
}
Write-Output "Unregistered scheduled task: $taskName"
