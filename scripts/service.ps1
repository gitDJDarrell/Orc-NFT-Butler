<#
.SYNOPSIS
  Manage the Orc Butler bot as a durable Windows Task Scheduler-backed
  background service: install / start / stop / status / uninstall.

.DESCRIPTION
  Two scheduled tasks, both running scripts\run-bot.ps1 (which runs the
  production build `node dist/index.js` in the foreground, from the project
  root, with rotating logs - see that script for details):

    OrcButlerBot            Triggered at user logon. Restart-on-failure:
                             up to 999 retries, every 1 minute. No execution
                             time limit, since it must run indefinitely.

    OrcButlerBot-Watchdog   Triggered every 5 minutes, forever, as a safety
                             net for the rare case the logon task's own
                             restart-on-failure doesn't catch a death (e.g.
                             it hit its retry cap, or was disabled). The
                             app-level single-instance lock in src/index.ts
                             (.bot.lock, PID + liveness check) makes this a
                             cheap, instant no-op whenever the bot is
                             already up - it only actually starts it if
                             nothing else did.

  Both tasks run as the current user with "run only when user is logged on"
  (LogonType Interactive) - no password is ever stored. See README.md
  "Running as a background service" for how to move to a true no-login/
  boot-time setup later (SYSTEM account or NSSM), which this script does
  NOT set up by default to avoid the extra privilege.

.PARAMETER Action
  install | start | stop | status | uninstall
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("install", "start", "stop", "status", "uninstall")]
    [string]$Action
)

$ErrorActionPreference = "Stop"

$TaskNameLogon = "OrcButlerBot"
$TaskNameWatchdog = "OrcButlerBot-Watchdog"
$AllTaskNames = @($TaskNameLogon, $TaskNameWatchdog)

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RunnerPath = Join-Path $PSScriptRoot "run-bot.ps1"
$LockFile = Join-Path $ProjectRoot ".bot.lock"

function Get-LockedProcessId {
    if (Test-Path $LockFile) {
        $raw = (Get-Content $LockFile -Raw).Trim()
        $parsed = 0
        if ([int]::TryParse($raw, [ref]$parsed)) {
            return $parsed
        }
    }
    return $null
}

function Test-ProcessAlive([int]$ProcessId) {
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Install-BotTasks {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunnerPath`"" `
        -WorkingDirectory $ProjectRoot

    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    $commonSettingsArgs = @{
        ExecutionTimeLimit        = ([TimeSpan]::Zero) # no limit - this must run indefinitely
        RestartCount               = 999
        RestartInterval            = (New-TimeSpan -Minutes 1)
        MultipleInstances          = "IgnoreNew" # Task Scheduler's own overlap guard, on top of the app-level lock
        AllowStartIfOnBatteries    = $true
        DontStopIfGoingOnBatteries = $true
        StartWhenAvailable         = $true
    }

    $logonSettings = New-ScheduledTaskSettingsSet @commonSettingsArgs
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $TaskNameLogon -Action $action -Trigger $logonTrigger `
        -Settings $logonSettings -Principal $principal -Force | Out-Null
    Write-Host "[service] Registered '$TaskNameLogon' (trigger: at logon; restart-on-failure: 999x / 1min; no exec time limit)."

    $watchdogSettings = New-ScheduledTaskSettingsSet @commonSettingsArgs
    $watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
    Register-ScheduledTask -TaskName $TaskNameWatchdog -Action $action -Trigger $watchdogTrigger `
        -Settings $watchdogSettings -Principal $principal -Force | Out-Null
    Write-Host "[service] Registered '$TaskNameWatchdog' (trigger: every 5 min, forever; safety net, no-ops if already running)."

    Write-Host "[service] Install complete. Run 'npm run service:start' to launch it now (or just log on again)."
}

function Start-BotTasks {
    Start-ScheduledTask -TaskName $TaskNameLogon
    Write-Host "[service] Started '$TaskNameLogon' now."
}

function Stop-BotTasks {
    foreach ($name in $AllTaskNames) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($task -and $task.State -eq "Running") {
            # Stop-ScheduledTask is Task-Scheduler-initiated, not an external
            # kill - it does not trip the task's own restart-on-failure.
            Stop-ScheduledTask -TaskName $name
            Write-Host "[service] Told Task Scheduler to stop '$name'."
        }
    }

    Start-Sleep -Seconds 2
    $lockedPid = Get-LockedProcessId
    if ($lockedPid -and (Test-ProcessAlive $lockedPid)) {
        Write-Host "[service] pid $lockedPid still alive after Stop-ScheduledTask - forcing termination."
        Stop-Process -Id $lockedPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    if (Test-Path $LockFile) {
        Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
    }

    Write-Host "[service] Stopped. Scheduled tasks are still installed (logon/watchdog triggers remain armed) -"
    Write-Host "[service] the bot will come back at next logon, or within 5 min via the watchdog. Use 'uninstall' to remove the tasks entirely."
}

function Show-BotStatus {
    foreach ($name in $AllTaskNames) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $task) {
            Write-Host "[$name] NOT INSTALLED"
            continue
        }
        $info = Get-ScheduledTaskInfo -TaskName $name
        Write-Host "[$name] State=$($task.State) LastRunTime=$($info.LastRunTime) LastResult=$($info.LastTaskResult) NextRunTime=$($info.NextRunTime)"
    }

    Write-Host ""
    $lockedPid = Get-LockedProcessId
    if ($lockedPid -and (Test-ProcessAlive $lockedPid)) {
        Write-Host "[bot] RUNNING - pid $lockedPid"
    }
    elseif ($lockedPid) {
        Write-Host "[bot] NOT RUNNING - stale lock for pid $lockedPid (self-heals automatically on next launch)"
    }
    else {
        Write-Host "[bot] NOT RUNNING - no lock file present"
    }

    $stdoutLog = Join-Path $ProjectRoot "logs\bot-stdout.log"
    if (Test-Path $stdoutLog) {
        Write-Host ""
        Write-Host "--- last 10 lines of logs\bot-stdout.log ---"
        Get-Content $stdoutLog -Tail 10
    }
}

function Uninstall-BotTasks {
    Stop-BotTasks
    foreach ($name in $AllTaskNames) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "[service] Removed task '$name'."
        }
    }
    Write-Host "[service] Uninstall complete. logs/ and persisted state files (.watchlist-*.json) were left in place."
}

switch ($Action) {
    "install" { Install-BotTasks }
    "start" { Start-BotTasks }
    "stop" { Stop-BotTasks }
    "status" { Show-BotStatus }
    "uninstall" { Uninstall-BotTasks }
}
