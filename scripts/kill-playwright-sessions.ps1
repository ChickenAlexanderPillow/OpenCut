param(
	[switch]$Quiet
)

$ErrorActionPreference = "Stop"

function Get-PlaywrightProcesses {
	Get-CimInstance Win32_Process | Where-Object {
		$cmd = $_.CommandLine
		if (-not $cmd) { return $false }
		return (
			$cmd -match "@playwright/mcp" -or
			$cmd -match "\\@playwright\\mcp\\cli\.js" -or
			$cmd -match "playwright-mcp" -or
			$cmd -match "--remote-debugging-pipe" -or
			$cmd -match "--enable-automation"
		)
	}
}

$killed = [System.Collections.Generic.HashSet[int]]::new()

for ($pass = 1; $pass -le 4; $pass++) {
	$targets = @(Get-PlaywrightProcesses | Sort-Object ProcessId -Unique)
	if ($targets.Count -eq 0) {
		break
	}

	foreach ($proc in $targets) {
		$processId = [int]$proc.ProcessId
		if ($killed.Contains($processId)) {
			continue
		}
		try {
			Stop-Process -Id $processId -Force -ErrorAction Stop
			[void]$killed.Add($processId)
		} catch {
			# Ignore races where process exits before kill.
		}
	}

	Start-Sleep -Milliseconds 200
}

$remaining = @(Get-PlaywrightProcesses | Sort-Object ProcessId -Unique)
if (-not $Quiet) {
	Write-Host ("Killed Playwright-related processes: {0}" -f $killed.Count)
	if ($remaining.Count -gt 0) {
		$remainingList = ($remaining | ForEach-Object { "$($_.Name)#$($_.ProcessId)" } | Sort-Object) -join ", "
		Write-Host ("Still running: {0}" -f $remainingList)
		exit 1
	}
	Write-Host "No Playwright-related processes remain."
}
