<#
.SYNOPSIS
  Production launcher for the Orc Butler bot. Runs `node dist/index.js` in
  the foreground so a Task Scheduler action's lifetime tracks the bot's.

.DESCRIPTION
  - Always resolves the project root from this script's own location (not
    the caller's cwd), then sets the working directory there, since the app
    loads `.env` via `dotenv/config`, which resolves relative to cwd.
  - Checks .bot.lock (the same lockfile src/index.ts's app-level
    single-instance guard uses) BEFORE touching any log file, so a
    concurrent second launch (task + watchdog + a stray manual run racing
    each other) exits immediately without ever opening/rotating/truncating
    a log file the live instance still has open. This is a fast-path
    convenience check only -- the Node process still does its own
    authoritative check on startup (acquireSingleInstanceLock), which is
    what actually closes the race if two launches slip past this check at
    the exact same moment.
  - Rotates logs/bot-stdout.log and logs/bot-stderr.log to a timestamped
    archive before each run, keeping only the last $MaxArchivedLogs
    archives per stream -- every (re)start (a crash-triggered restart, a
    watchdog recovery, or a manual `npm run service:start`) gets a fresh
    current log, and old ones age out automatically.
  - Uses Start-Process -RedirectStandardOutput/-RedirectStandardError
    (not PowerShell's `1>`/`2>`, which pulls external-process output
    through PowerShell's own text pipeline and re-encodes it -- observed
    as garbled UTF-16-with-nulls output) so the log files hold node's raw,
    readable output.
  - Exits with node's own exit code, so Task Scheduler's restart-on-failure
    can tell a graceful stop (exit 0 - do not restart) from a crash
    (non-zero - restart it). The app's SIGINT/SIGTERM/SIGHUP handler
    (src/index.ts) is what makes a graceful stop exit 0.
#>

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$LockFile = Join-Path $ProjectRoot ".bot.lock"

function Test-ProcessAlive([int]$ProcessId) {
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

if (Test-Path $LockFile) {
    $raw = Get-Content $LockFile -Raw -ErrorAction SilentlyContinue
    $existingPid = 0
    if ($raw -and [int]::TryParse($raw.Trim(), [ref]$existingPid) -and (Test-ProcessAlive $existingPid)) {
        Write-Host "[run-bot] $(Get-Date -Format o) Another instance is already running (pid $existingPid) - exiting cleanly without touching logs."
        exit 0
    }
}

$LogsDir = Join-Path $ProjectRoot "logs"
if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir | Out-Null
}

$MaxArchivedLogs = 10

function Rotate-Log {
    param([string]$CurrentPath, [string]$Prefix)

    if (Test-Path $CurrentPath) {
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $archivePath = Join-Path $LogsDir "$Prefix-$timestamp.log"
        try {
            Move-Item -Path $CurrentPath -Destination $archivePath -Force -ErrorAction Stop
        }
        catch {
            # Only reachable via a genuine race (another instance started
            # between the lock check above and here) -- the lock check
            # above handles the common case, this is defense in depth.
            Write-Host "[run-bot] Could not rotate $CurrentPath (likely still open by a running instance) -- skipping rotation this run."
        }
    }

    $archives = Get-ChildItem -Path $LogsDir -Filter "$Prefix-*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    if ($archives.Count -gt $MaxArchivedLogs) {
        $archives | Select-Object -Skip $MaxArchivedLogs | Remove-Item -Force
    }
}

$StdoutLog = Join-Path $LogsDir "bot-stdout.log"
$StderrLog = Join-Path $LogsDir "bot-stderr.log"

Rotate-Log -CurrentPath $StdoutLog -Prefix "bot-stdout"
Rotate-Log -CurrentPath $StderrLog -Prefix "bot-stderr"

Write-Host "[run-bot] $(Get-Date -Format o) Starting 'node dist/index.js' in $ProjectRoot"

$proc = Start-Process -FilePath "node" -ArgumentList "dist/index.js" -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -NoNewWindow -PassThru -Wait
$exitCode = $proc.ExitCode

Write-Host "[run-bot] $(Get-Date -Format o) node exited with code $exitCode"
exit $exitCode
