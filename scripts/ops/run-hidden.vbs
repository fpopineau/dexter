' run-hidden.vbs -- launch a command with NO console window.
' The \Dexter\Watchdog task fires every 5 minutes; run interactively it
' would flash a console each time. Task Scheduler's only flash-free
' alternative (non-interactive logon) breaks on password-less/MSA setups,
' so the classic wscript window-style-0 wrapper is used instead.
' Usage: wscript.exe run-hidden.vbs <exe> [args...]
Dim sh, cmd, i
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
    cmd = cmd & """" & WScript.Arguments(i) & """ "
Next
sh.Run Trim(cmd), 0, False
