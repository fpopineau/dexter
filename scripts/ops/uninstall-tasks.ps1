# Removes the \Dexter scheduled tasks registered by install-tasks.ps1.
# Does not touch running processes — a live gateway console keeps running.
$ErrorActionPreference = 'SilentlyContinue'
Unregister-ScheduledTask -TaskPath '\Dexter\' -TaskName 'Stack' -Confirm:$false
Unregister-ScheduledTask -TaskPath '\Dexter\' -TaskName 'Watchdog' -Confirm:$false
# Drop the now-empty \Dexter task folder (fails harmlessly if not empty).
$sched = New-Object -ComObject Schedule.Service
$sched.Connect()
$sched.GetFolder('\').DeleteFolder('Dexter', 0)
Write-Output 'removed \Dexter tasks'
