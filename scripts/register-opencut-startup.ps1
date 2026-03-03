$ErrorActionPreference = "Stop"

$taskName = "OpenCutDockerAutoStart"
$scriptPath = Join-Path $PSScriptRoot "opencut-auto-up.ps1"
$startupDir = [Environment]::GetFolderPath("Startup")
$startupVbsPath = Join-Path $startupDir "OpenCutDockerAutoStart.vbs"

if (-not (Test-Path $scriptPath)) {
	throw "Startup script not found: $scriptPath"
}

$action = New-ScheduledTaskAction `
	-Execute "powershell.exe" `
	-Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

try {
	Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
} catch {}
try {
	Register-ScheduledTask `
		-TaskName $taskName `
		-Action $action `
		-Trigger $trigger `
		-Description "Auto-start OpenCut docker stack on user logon" | Out-Null
	Write-Output "Registered scheduled task: $taskName"
	exit 0
} catch {
	if ($_.Exception.Message -notmatch "Access is denied") {
		throw
	}
}

# Fallback for restricted machines: Startup-folder VBScript launcher (no admin required).
$escapedScriptPath = $scriptPath.Replace("\", "\\")
$vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$escapedScriptPath""", 0
"@
Set-Content -Path $startupVbsPath -Value $vbs -Encoding ASCII
Write-Output "Registered startup-folder launcher: $startupVbsPath"
