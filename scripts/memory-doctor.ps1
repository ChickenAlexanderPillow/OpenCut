param(
	[ValidateSet("audit", "reduce")]
	[string]$Mode = "audit",
	[switch]$Aggressive
)

$ErrorActionPreference = "SilentlyContinue"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoPattern = [regex]::Escape($repoRoot)
$selfPid = $PID

function Get-SystemSnapshot {
	$os = Get-CimInstance Win32_OperatingSystem
	$totalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
	$freeGb = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
	$usedGb = [math]::Round($totalGb - $freeGb, 2)
	$usedPct = if ($totalGb -gt 0) {
		[math]::Round(($usedGb / $totalGb) * 100, 1)
	}
	else {
		0
	}

	$counterPaths = @(
		"\Memory\Committed Bytes",
		"\Memory\Commit Limit",
		"\Memory\Pool Nonpaged Bytes",
		"\Memory\Pool Paged Bytes",
		"\Memory\Standby Cache Reserve Bytes",
		"\Memory\Standby Cache Normal Priority Bytes",
		"\Memory\Modified Page List Bytes"
	)
	$counterValues = @{}
	$counter = Get-Counter -Counter $counterPaths
	foreach ($sample in $counter.CounterSamples) {
		$name = $sample.Path.Split("\")[-1]
		$counterValues[$name] = [math]::Round($sample.CookedValue / 1GB, 3)
	}

	[pscustomobject]@{
		TotalRamGb                = $totalGb
		UsedRamGb                 = $usedGb
		FreeRamGb                 = $freeGb
		UsedPct                   = $usedPct
		CommittedGb               = $counterValues["committed bytes"]
		CommitLimitGb             = $counterValues["commit limit"]
		PoolNonpagedGb            = $counterValues["pool nonpaged bytes"]
		PoolPagedGb               = $counterValues["pool paged bytes"]
		StandbyReserveGb          = $counterValues["standby cache reserve bytes"]
		StandbyNormalPriorityGb   = $counterValues["standby cache normal priority bytes"]
		ModifiedPageListGb        = $counterValues["modified page list bytes"]
	}
}

function Get-ProcessGroupSummary {
	Get-Process |
		Group-Object ProcessName |
		ForEach-Object {
			[pscustomobject]@{
				Name           = $_.Name
				Count          = $_.Count
				TotalWS_GB     = [math]::Round((($_.Group | Measure-Object -Property WS -Sum).Sum) / 1GB, 3)
				TotalPrivateGB = [math]::Round((($_.Group | Measure-Object -Property PM -Sum).Sum) / 1GB, 3)
			}
		} |
		Sort-Object TotalWS_GB -Descending |
		Select-Object -First 15
}

function Get-ProjectProcesses {
	Get-CimInstance Win32_Process | Where-Object {
		$_.ProcessId -ne $selfPid -and (
			$_.CommandLine -match $repoPattern -or
			$_.CommandLine -match "next\\dist\\bin\\next.*dev" -or
			$_.CommandLine -match "bun\s+run\s+dev" -or
			$_.CommandLine -match "scripts/dev-web-low-mem.mjs" -or
			$_.CommandLine -match "fs.read=$repoPattern"
		)
	}
}

function Get-ProcessTotalWsGb {
	param([string]$Name)
	$items = Get-Process -Name $Name -ErrorAction SilentlyContinue
	if (-not $items) {
		return 0
	}
	return [math]::Round((($items | Measure-Object -Property WS -Sum).Sum) / 1GB, 3)
}

function Get-DockerMemorySummary {
	$dockerRunning = Get-Process -Name "Docker Desktop", "com.docker.backend" -ErrorAction SilentlyContinue
	if (-not $dockerRunning) {
		return @()
	}
	try {
		$lines = docker stats --no-stream --format "{{.Name}}|{{.MemUsage}}" 2>$null
		if ($LASTEXITCODE -ne 0 -or -not $lines) {
			return @()
		}

		$rows = @()
		foreach ($line in $lines) {
			if (-not $line.Contains("|")) {
				continue
			}
			$parts = $line.Split("|", 2)
			$name = $parts[0].Trim()
			$memText = $parts[1].Trim()
			$usage = ($memText.Split("/")[0]).Trim()
			$usageNumber = 0.0
			if ($usage -match "^([0-9]+(?:\.[0-9]+)?)\s*([KMG]i?)B$") {
				$value = [double]$matches[1]
				$unit = $matches[2]
				switch ($unit) {
					"KB" { $usageNumber = $value / 1024 / 1024 }
					"KiB" { $usageNumber = $value / 1024 / 1024 }
					"MB" { $usageNumber = $value / 1024 }
					"MiB" { $usageNumber = $value / 1024 }
					"GB" { $usageNumber = $value }
					"GiB" { $usageNumber = $value }
					default { $usageNumber = 0.0 }
				}
			}
			$rows += [pscustomobject]@{
				Name      = $name
				MemUsage  = $usage
				MemGB     = [math]::Round($usageNumber, 3)
			}
		}
		return $rows | Sort-Object MemGB -Descending
	}
	catch {
		return @()
	}
}

function Print-Audit {
	$snapshot = Get-SystemSnapshot
	$groups = Get-ProcessGroupSummary
	$docker = Get-DockerMemorySummary
	$project = Get-ProjectProcesses |
		Select-Object ProcessId, Name,
		@{ Name = "WS_GB"; Expression = { [math]::Round($_.WorkingSetSize / 1GB, 3) } },
		CommandLine |
		Sort-Object WS_GB -Descending

	$chromeWs = Get-ProcessTotalWsGb -Name "chrome"
	$vmmem = Get-Process -Name "vmmemWSL" -ErrorAction SilentlyContinue
	$vmmemPrivate = if ($vmmem) {
		[math]::Round((($vmmem | Measure-Object -Property PM -Sum).Sum) / 1GB, 3)
	}
	else {
		0
	}

	Write-Output "=== MEMORY SNAPSHOT ==="
	$snapshot | Format-Table -AutoSize

	Write-Output "`n=== TOP PROCESS GROUPS (WS) ==="
	$groups | Format-Table -AutoSize

	Write-Output "`n=== PROJECT-RELATED PROCESSES ==="
	if ($project) {
		$project | Select-Object -First 20 | Format-Table -Wrap -AutoSize
	}
	else {
		Write-Output "No active project-related dev processes found."
	}

	Write-Output "`n=== MAJOR CONTRIBUTORS ==="
	[pscustomobject]@{
		ChromeTotalWS_GB = $chromeWs
		vmmemWSL_Private_GB = $vmmemPrivate
	} | Format-Table -AutoSize

	Write-Output "`n=== DOCKER CONTAINER MEMORY ==="
	if ($docker) {
		$docker | Select-Object -First 15 | Format-Table -AutoSize
	}
	else {
		Write-Output "Docker not running or no containers available."
	}

	Write-Output "`n=== RECOMMENDED REDUCTIONS ==="
	if ($chromeWs -ge 8) {
		Write-Output "- Chrome is above 8 GB WS. Restart Chrome or close heavy project tabs/profiles."
	}
	if ($vmmemPrivate -ge 2) {
		Write-Output "- WSL is above 2 GB private memory. Run: wsl --shutdown (or use reduce mode)."
	}
	if ($snapshot.PoolNonpagedGb -ge 2) {
		Write-Output "- Nonpaged pool is elevated (>2 GB). If persistent after reboot, investigate driver/AV leaks."
	}
	if (($project | Measure-Object).Count -gt 0) {
		Write-Output "- Project dev processes are active. Use reduce mode to free memory without reboot."
	}
	$topDocker = $docker | Select-Object -First 1
	if ($topDocker -and $topDocker.MemGB -ge 2) {
		Write-Output "- Container '$($topDocker.Name)' is high-memory ($($topDocker.MemUsage))."
	}
	if (
		$chromeWs -lt 8 -and
		$vmmemPrivate -lt 2 -and
		$snapshot.PoolNonpagedGb -lt 2 -and
		(($project | Measure-Object).Count -eq 0) -and
		(-not $topDocker -or $topDocker.MemGB -lt 2)
	) {
		Write-Output "- No dominant offender detected from standard project/dev process signals."
	}
}

function Stop-ProcessList {
	param([array]$Items)
	$killed = @()
	foreach ($item in $Items) {
		try {
			Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop
			$killed += $item.ProcessId
		}
		catch {
		}
	}
	return $killed
}

function Run-Reduce {
	$before = Get-SystemSnapshot
	$chromeBefore = Get-ProcessTotalWsGb -Name "chrome"

	$project = Get-ProjectProcesses
	$projectKilled = Stop-ProcessList -Items $project

	$dockerProjectStopped = $false
	$dockerRunning = Get-Process -Name "Docker Desktop", "com.docker.backend" -ErrorAction SilentlyContinue
	if ($dockerRunning) {
		try {
			$composePids = docker compose -f (Join-Path $repoRoot "docker-compose.yml") ps -q 2>$null
			if ($LASTEXITCODE -eq 0 -and $composePids) {
				docker compose -f (Join-Path $repoRoot "docker-compose.yml") down 2>$null | Out-Null
				if ($LASTEXITCODE -eq 0) {
					$dockerProjectStopped = $true
				}
			}
		}
		catch {
		}
	}

	$dockerKilled = @()
	$wslShutdown = $false
	if ($Aggressive) {
		$dockerTargets = Get-Process -Name "com.docker.backend", "Docker Desktop" -ErrorAction SilentlyContinue
		foreach ($item in $dockerTargets) {
			try {
				Stop-Process -Id $item.Id -Force -ErrorAction Stop
				$dockerKilled += $item.Id
			}
			catch {
			}
		}

		wsl --shutdown | Out-Null
		$wslShutdown = $true
	}

	$chromeKilled = @()
	if ($Aggressive) {
		$chromeItems = Get-Process -Name "chrome" -ErrorAction SilentlyContinue
		foreach ($item in $chromeItems) {
			try {
				Stop-Process -Id $item.Id -Force -ErrorAction Stop
				$chromeKilled += $item.Id
			}
			catch {
			}
		}
	}

	Start-Sleep -Seconds 2

	$after = Get-SystemSnapshot
	$chromeAfter = Get-ProcessTotalWsGb -Name "chrome"

	Write-Output "=== REDUCE SUMMARY ==="
	[pscustomobject]@{
		ProjectPidsKilled   = if ($projectKilled.Count -gt 0) { ($projectKilled -join ",") } else { "-" }
		DockerProjectDown   = $dockerProjectStopped
		DockerPidsKilled    = if ($dockerKilled.Count -gt 0) { ($dockerKilled -join ",") } else { "-" }
		WslShutdown         = $wslShutdown
		ChromePidsKilled    = if ($chromeKilled.Count -gt 0) { ($chromeKilled -join ",") } else { "-" }
		ChromeWSBeforeGB    = $chromeBefore
		ChromeWSAfterGB     = $chromeAfter
		UsedBeforeGB        = $before.UsedRamGb
		UsedAfterGB         = $after.UsedRamGb
		FreedGB             = [math]::Round($before.UsedRamGb - $after.UsedRamGb, 2)
		UsedBeforePct       = $before.UsedPct
		UsedAfterPct        = $after.UsedPct
	} | Format-Table -AutoSize
}

if ($Mode -eq "audit") {
	Print-Audit
	exit 0
}

Run-Reduce
