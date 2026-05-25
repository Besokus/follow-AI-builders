# Create scheduled task for daily AI Builders Digest
$taskName = "AI Builders Digest"
$scriptPath = "C:\Users\Knight\.claude\skills\follow-builders\scripts\send-digest.bat"
$workingDir = "C:\Users\Knight\.claude\skills\follow-builders\scripts"

# Delete existing task if it exists
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Create the task action
$action = New-ScheduledTaskAction -Execute $scriptPath -WorkingDirectory $workingDir

# Create trigger for daily at 8:30 AM
$trigger = New-ScheduledTaskTrigger -Daily -At 08:30

# Run as current user
$principal = New-ScheduledTaskPrincipal -UserId "Knight" -LogonType S4U -RunLevel Limited

# Settings
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# Register the task
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Daily AI Builders Digest email at 8:30 AM Beijing time"

Write-Host "Task '$taskName' created successfully!"
Write-Host "It will run daily at 08:30."
