# start-windows.ps1 - demarre la console Leboncoin (appele au login par le
# lanceur Startup ou la tache planifiee). Si le service tourne deja, ouvre
# simplement l'interface.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# Node 24 requis
try {
    $nodeVersion = (node -v) -replace 'v(\d+)\..*', '$1'
    if ([int]$nodeVersion -lt 24) { throw "Node >= 24 requis (trouve $(node -v))" }
} catch {
    Write-Error "Node.js 24 introuvable : installez-le depuis https://nodejs.org - $_"
    exit 1
}

Set-Location $root

# dependances absentes ? installation silencieuse
if (-not (Test-Path "$root\node_modules")) {
    Write-Host "Installation des dependances (premiere fois)..."
    npm install --no-fund --no-audit | Out-Null
}

# frontend non construit ? build
$dist = "$root\apps\web\dist"
if (-not (Test-Path "$dist\index.html")) {
    Write-Host "Construction du frontend..."
    npm run build -w apps/web | Out-Null
}

# port 8787 deja occupe ? alors juste ouvrir l'interface
$alreadyRunning = $false
try {
    $conn = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
    $alreadyRunning = ($null -ne $conn)
} catch { $alreadyRunning = $false }

if (-not $alreadyRunning) {
    New-Item -ItemType Directory -Force -Path "$root\data" | Out-Null
    $env:DATA_DIR = "$root\data"
    $env:LBC_MODE = "live"
    $proc = Start-Process -FilePath "node" `
        -ArgumentList "--import", "tsx", "$root\apps\server\src\index.ts" `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput "$root\data\console.out.log" `
        -RedirectStandardError "$root\data\console.err.log"
    # attend que le port reponde (max 30 s)
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            $conn = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
            if ($null -ne $conn) { break }
        } catch {}
    }
}

Start-Process "http://127.0.0.1:8787"
