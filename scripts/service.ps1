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

  Both tasks run as the current interactive user, least privilege:

    - LogonType Interactive / InteractiveToken - runs only while this user is
      logged on. No password is ever stored, and no "log on as a batch job"
      right is required.
    - RunLevel Limited / LeastPrivilege - the bot is NOT elevated. It only
      needs its own project directory and outbound HTTPS; running an
      unattended process as admin would be a real downgrade in safety.
    - The logon trigger is scoped to THIS user's SID rather than "any user's
      logon", which is what actually needs elevated rights to register and is
      a common source of 0x80070005 / Access Denied.

  Registration is attempted twice: Register-ScheduledTask first, then
  schtasks.exe /Create /XML, which goes through a different code path and
  sometimes succeeds where the CIM-backed cmdlet does not. Each task is
  registered independently, so one failing never abandons the other.

  Installing still requires an ELEVATED PowerShell. The script detects when
  it isn't elevated and says so plainly rather than surfacing a raw CIM
  exception.

  See README.md "Running as a background service" for how to move to a true
  no-login/boot-time setup later (SYSTEM account or NSSM), which this script
  does NOT set up by default to avoid the extra privilege.

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

function Test-IsElevated {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

<#
  The authoritative "DOMAIN\User" for the CURRENT interactive user.

  Deliberately not "$env:USERDOMAIN\$env:USERNAME": those two can disagree
  with the real account name on Microsoft-account and Azure-AD-joined
  machines (where the principal is e.g. "AzureAD\someone@example.com"), and
  registering a task for a UserId that doesn't resolve is one of the ways
  Task Scheduler reports 0x80070005 / Access Denied.
#>
function Get-CurrentUserId {
    return [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}

function ConvertTo-XmlText([string]$Value) {
    return $Value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;")
}

<#
  Builds a Task Scheduler XML definition for the fallback path.

  Least-privilege by construction:
    - LogonType InteractiveToken -> runs only while this user is logged on,
      so NO password is stored and no "log on as a batch job" right is needed.
    - RunLevel LeastPrivilege    -> the bot is NOT elevated. It only needs to
      read/write its own project directory; nothing it does requires admin.
    - LogonTrigger scoped to a specific UserId -> fires on THIS user's logon
      rather than "any user's", which is what actually requires privilege.

  The repeating trigger omits <Duration> entirely, which Task Scheduler reads
  as "repeat indefinitely". That avoids [TimeSpan]::MaxValue, which the
  PowerShell cmdlet path serializes badly on Windows PowerShell 5.1.
#>
function New-BotTaskXml {
    param(
        [Parameter(Mandatory = $true)][string]$UserId,
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][ValidateSet("Logon", "Repeat")][string]$TriggerKind
    )

    $safeUser = ConvertTo-XmlText $UserId
    $safeDesc = ConvertTo-XmlText $Description
    $safeArgs = ConvertTo-XmlText "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunnerPath`""
    $safeCwd = ConvertTo-XmlText $ProjectRoot

    if ($TriggerKind -eq "Logon") {
        $trigger = @"
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$safeUser</UserId>
    </LogonTrigger>
"@
    }
    else {
        $trigger = @"
    <TimeTrigger>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
"@
    }

    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>$safeDesc</Description>
  </RegistrationInfo>
  <Triggers>
$trigger
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$safeUser</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>$safeArgs</Arguments>
      <WorkingDirectory>$safeCwd</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

<#
  Registers one task, trying the cmdlet first and falling back to
  schtasks.exe /Create /XML, which goes through a different code path and
  sometimes succeeds where the CIM-based cmdlet returns Access Denied.
  Returns a result object rather than throwing, so one task failing doesn't
  abandon the other.
#>
function Register-BotTask {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$UserId,
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][ValidateSet("Logon", "Repeat")][string]$TriggerKind,
        [Parameter(Mandatory = $true)]$Action,
        [Parameter(Mandatory = $true)]$Principal,
        [Parameter(Mandatory = $true)]$Settings
    )

    $errors = @()

    # --- Attempt 1: the PowerShell cmdlet ---
    try {
        if ($TriggerKind -eq "Logon") {
            # Scoped to THIS user. Without -User this is an "at log on of ANY
            # user" trigger, which requires higher privilege to register and
            # is a common source of 0x80070005.
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
        }
        else {
            # A long finite duration rather than [TimeSpan]::MaxValue, which
            # Windows PowerShell 5.1 does not serialize reliably.
            $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
        }

        $registerArgs = @{
            TaskName    = $TaskName
            Action      = $Action
            Trigger     = $trigger
            Settings    = $Settings
            Principal   = $Principal
            Description = $Description
            Force       = $true
            ErrorAction = "Stop"
        }
        Register-ScheduledTask @registerArgs | Out-Null
        return [pscustomobject]@{ Name = $TaskName; Ok = $true; Method = "Register-ScheduledTask"; Errors = @() }
    }
    catch {
        $errors += "Register-ScheduledTask: $($_.Exception.Message.Trim())"
    }

    # --- Attempt 2: schtasks.exe /Create /XML ---
    $xmlPath = Join-Path ([System.IO.Path]::GetTempPath()) ("orcbutler-" + [guid]::NewGuid().ToString("N") + ".xml")
    try {
        $xml = New-BotTaskXml -UserId $UserId -Description $Description -TriggerKind $TriggerKind
        # schtasks is happiest with UTF-16, matching the XML declaration above.
        [System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)

        # First without /RU (the principal is fully described by the XML),
        # then with /RU as a second try. Neither needs /RP: an InteractiveToken
        # task never stores a password.
        $output = & schtasks.exe /Create /TN $TaskName /XML $xmlPath /F 2>&1
        if ($LASTEXITCODE -eq 0) {
            return [pscustomobject]@{ Name = $TaskName; Ok = $true; Method = "schtasks /XML"; Errors = $errors }
        }
        $errors += "schtasks /XML: $($output -join ' ')".Trim()

        $output = & schtasks.exe /Create /TN $TaskName /XML $xmlPath /RU $UserId /F 2>&1
        if ($LASTEXITCODE -eq 0) {
            return [pscustomobject]@{ Name = $TaskName; Ok = $true; Method = "schtasks /XML /RU"; Errors = $errors }
        }
        $errors += "schtasks /XML /RU: $($output -join ' ')".Trim()
    }
    catch {
        $errors += "schtasks fallback: $($_.Exception.Message.Trim())"
    }
    finally {
        Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
    }

    return [pscustomobject]@{ Name = $TaskName; Ok = $false; Method = $null; Errors = $errors }
}

function Install-BotTasks {
    $userId = Get-CurrentUserId
    $elevated = Test-IsElevated

    Write-Host "[service] Installing for user '$userId' (project root: $ProjectRoot)."
    if (-not $elevated) {
        Write-Host ""
        Write-Host "[service] WARNING: this shell is NOT running as administrator." -ForegroundColor Yellow
        Write-Host "[service] Registering a scheduled task normally requires elevation, and the usual" -ForegroundColor Yellow
        Write-Host "[service] symptom of running without it is exactly:" -ForegroundColor Yellow
        Write-Host "[service]     Register-ScheduledTask : Access is denied.  (HRESULT 0x80070005)" -ForegroundColor Yellow
        Write-Host "[service] Close this window, right-click PowerShell -> 'Run as administrator', then:" -ForegroundColor Yellow
        Write-Host "[service]     cd `"$ProjectRoot`"; npm run service:install" -ForegroundColor Yellow
        Write-Host "[service] Attempting anyway in case this machine's policy permits it..." -ForegroundColor Yellow
        Write-Host ""
    }

    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunnerPath`"" -WorkingDirectory $ProjectRoot

    # Least privilege, deliberately:
    #   Interactive     -> runs only while this user is logged on; no stored
    #                      password, no "log on as a batch job" right needed.
    #   RunLevel Limited-> NOT elevated. The bot only touches its own project
    #                      directory and outbound HTTPS; it has no need for
    #                      admin, and granting it would be a real downgrade in
    #                      safety posture for a process that runs unattended.
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

    $commonSettingsArgs = @{
        ExecutionTimeLimit         = ([TimeSpan]::Zero) # no limit - this must run indefinitely
        RestartCount               = 999
        RestartInterval            = (New-TimeSpan -Minutes 1)
        MultipleInstances          = "IgnoreNew" # Task Scheduler's own overlap guard, on top of the app-level lock
        AllowStartIfOnBatteries    = $true
        DontStopIfGoingOnBatteries = $true
        StartWhenAvailable         = $true
    }

    $results = @()
    $results += Register-BotTask -TaskName $TaskNameLogon -UserId $userId -TriggerKind "Logon" `
        -Description "Orc Butler NFT/DeFi agent - starts the bot at logon (restart-on-failure 999x/1min)." `
        -Action $action -Principal $principal -Settings (New-ScheduledTaskSettingsSet @commonSettingsArgs)

    $results += Register-BotTask -TaskName $TaskNameWatchdog -UserId $userId -TriggerKind "Repeat" `
        -Description "Orc Butler watchdog - every 5 min, no-ops if the bot is already running (see .bot.lock)." `
        -Action $action -Principal $principal -Settings (New-ScheduledTaskSettingsSet @commonSettingsArgs)

    Write-Host ""
    foreach ($r in $results) {
        if ($r.Ok) {
            Write-Host "[service] OK      '$($r.Name)' registered via $($r.Method)."
            if ($r.Errors.Count -gt 0) {
                Write-Host "[service]           (first attempt failed, fallback succeeded: $($r.Errors[0]))"
            }
        }
        else {
            Write-Host "[service] FAILED  '$($r.Name)' could not be registered:" -ForegroundColor Red
            foreach ($e in $r.Errors) { Write-Host "[service]           - $e" -ForegroundColor Red }
        }
    }

    $ok = @($results | Where-Object { $_.Ok })
    $failed = @($results | Where-Object { -not $_.Ok })

    Write-Host ""
    if ($failed.Count -eq 0) {
        Write-Host "[service] Install complete ($($ok.Count)/$($results.Count) tasks). Run 'npm run service:start' to launch it now (or just log on again)."
        return
    }

    # Partial success is genuinely useful: the logon task alone already gives
    # start-at-logon, and the watchdog alone already gives 5-minute recovery.
    if ($ok.Count -gt 0) {
        Write-Host "[service] PARTIAL install: $($ok.Count) of $($results.Count) tasks registered." -ForegroundColor Yellow
        if ($ok.Name -contains $TaskNameLogon) {
            Write-Host "[service] The bot WILL still start at logon; only the 5-minute watchdog is missing." -ForegroundColor Yellow
        }
        else {
            Write-Host "[service] The watchdog is installed, so the bot will be (re)started within 5 minutes even without the logon task." -ForegroundColor Yellow
        }
    }
    else {
        Write-Host "[service] Install FAILED - no tasks were registered." -ForegroundColor Red
    }

    if (-not $elevated) {
        Write-Host "[service] Most likely cause: this shell is not elevated. Re-run from an administrator PowerShell:" -ForegroundColor Yellow
        Write-Host "[service]     cd `"$ProjectRoot`"; npm run service:install" -ForegroundColor Yellow
    }
    else {
        Write-Host "[service] This shell IS elevated, so the cause is likely group policy or endpoint-security software" -ForegroundColor Yellow
        Write-Host "[service] restricting Task Scheduler. The bot can still be run manually with:" -ForegroundColor Yellow
        Write-Host "[service]     powershell -NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`"" -ForegroundColor Yellow
    }

    exit 1
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

    $failed = @()
    foreach ($name in $AllTaskNames) {
        if (-not (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) { continue }

        try {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
            Write-Host "[service] Removed task '$name'."
            continue
        }
        catch {
            Write-Host "[service] Unregister-ScheduledTask failed for '$name' ($($_.Exception.Message.Trim())) - trying schtasks."
        }

        # Same fallback rationale as install: schtasks.exe takes a different
        # path than the CIM-backed cmdlet and sometimes succeeds where it fails.
        $output = & schtasks.exe /Delete /TN $name /F 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[service] Removed task '$name' via schtasks."
        }
        else {
            $failed += $name
            Write-Host "[service] FAILED to remove '$name': $($output -join ' ')" -ForegroundColor Red
        }
    }

    if ($failed.Count -gt 0) {
        Write-Host "[service] Could not remove: $($failed -join ', ')." -ForegroundColor Red
        if (-not (Test-IsElevated)) {
            Write-Host "[service] This shell is not elevated - re-run from an administrator PowerShell." -ForegroundColor Yellow
        }
        exit 1
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
