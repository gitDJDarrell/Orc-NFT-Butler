' ---------------------------------------------------------------------------
'  Truly-hidden launcher for run-bot.ps1.
'
'  WHY THIS EXISTS
'  powershell.exe is a CONSOLE-subsystem executable (PE subsystem 3), so
'  Windows allocates a console window at process-creation time -- BEFORE
'  PowerShell itself ever runs and can honor -WindowStyle Hidden. The result
'  is a console window that flashes visibly for a fraction of a second on
'  every launch. With the watchdog task firing every 5 minutes, that is a
'  pop-up 288 times a day.
'
'  wscript.exe is a GUI-subsystem executable (PE subsystem 2): no console is
'  ever allocated for it. Launching PowerShell *from* wscript with
'  intWindowStyle = 0 means the console is created already-hidden, so nothing
'  is ever painted on screen. This is the standard fix and works on every
'  supported Windows version (unlike conhost.exe --headless, which is
'  Windows 11+ only).
'
'  BEHAVIOR PRESERVED
'  bWaitOnReturn is True, NOT False. That matters: with False this script
'  would exit immediately, Task Scheduler would consider the action finished
'  while the bot was still running, and the task would drop to "Ready" with
'  the bot alive. That breaks `Stop-ScheduledTask` (used by
'  `npm run service:stop`), makes State=Running meaningless, and defeats the
'  task's own MultipleInstances=IgnoreNew guard. Waiting keeps the task's
'  lifetime tracking the bot's, exactly as the previous direct-powershell
'  action did.
'
'  The exit code from PowerShell (which is node's own exit code -- see
'  run-bot.ps1) is propagated back to Task Scheduler, so LastTaskResult and
'  restart-on-failure keep working.
'
'  Everything else is unchanged: run-bot.ps1 still does the single-instance
'  lock check, log rotation, and `node dist/index.js` from the project root.
' ---------------------------------------------------------------------------

Option Explicit

Dim fso, shell, scriptDir, runnerPath, command, exitCode

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Resolve run-bot.ps1 relative to THIS script's own location, so the pair
' stays portable if the project directory moves.
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
runnerPath = fso.BuildPath(scriptDir, "run-bot.ps1")

If Not fso.FileExists(runnerPath) Then
    ' No console exists to print to, so signal via a distinct exit code that
    ' shows up as the task's LastTaskResult.
    WScript.Quit 2
End If

' -WindowStyle Hidden is deliberately omitted: the window style is already
' governed by the 0 passed to Run() below, which is authoritative and applies
' at creation time.
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & runnerPath & Chr(34)

' 0 = hidden window, True = wait for it to finish (see BEHAVIOR PRESERVED).
exitCode = shell.Run(command, 0, True)

WScript.Quit exitCode
