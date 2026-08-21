# install-windows.ps1 - demarrage automatique de la console au login
# Essaie la tache planifiee (plus propre), et retombe sur le dossier Startup
# (aucun droit admin) si la politique machine refuse l'enregistrement.
# Usage : powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$taskName = "LeboncoinConsole"
$startScript = "$root\scripts\start-windows.ps1"

# --- 1. tache planifiee (peut echouer sans elevation sur certaines politiques)
$installed = "startup-folder"
try {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }

    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Description "Console locale Leboncoin - 127.0.0.1:8787 au login" | Out-Null
    $installed = "scheduled-task"
} catch {
    Write-Host "Tache planifiee refusee ($($_.Exception.Message)) - bascule dossier Startup"
}

# --- 2. repli : lanceur VBS cache dans shell:startup
if ($installed -eq "startup-folder") {
    $startup = [Environment]::GetFolderPath("Startup")
    $vbs = Join-Path $startup "LeboncoinConsole.vbs"
    $content = @"
' Demarrage Console Leboncoin au login (fenetre cachee)
CreateObject("WScript.Shell").Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$startScript""", 0, False
"@
    Set-Content -Path $vbs -Value $content -Encoding ASCII
    Write-Host "Lanceur installe : $vbs"
}

Write-Host "Methode : $installed - la console demarrera au login (http://127.0.0.1:8787)"
if ($installed -eq "scheduled-task") {
    Write-Host "Desinstallation : Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
} else {
    Write-Host "Desinstallation : supprimer LeboncoinConsole.vbs dans shell:startup"
}
