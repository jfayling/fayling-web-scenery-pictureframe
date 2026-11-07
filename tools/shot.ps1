# Renders one frame in headless Chrome and waits for it to land in ./shots.
#   powershell -File tools/shot.ps1 -Name pnw.png -Query "scene=pnw" [-W 1600 -H 900 -Frames 240] [-Page scenery.html]
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Query = '',
  [int]$W = 1600,
  [int]$H = 900,
  [int]$Frames = 240,
  [int]$Port = 8081,
  [string]$Page = '',
  [int]$TimeoutS = 90
)
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "shots\$Name"
if (Test-Path $out) { Remove-Item $out }
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = Join-Path $env:TEMP 'scenery-shot-profile'
$url = "http://localhost:$Port/$Page`?ui=0&shot=$Name&frames=$Frames&w=$W&h=$H"
if ($Query) { $url += "&$Query" }
$args = @('--headless=new', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11',
  '--disable-gpu-sandbox', '--ignore-gpu-blocklist', "--user-data-dir=$profile",
  "--window-size=$W,$H", $url)
$p = Start-Process -FilePath $chrome -ArgumentList $args -PassThru
$t = 0
while (-not (Test-Path $out) -and $t -lt $TimeoutS) { Start-Sleep -Milliseconds 500; $t += 0.5 }
Start-Sleep -Milliseconds 300
Get-Process -Id $p.Id -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*scenery-shot-profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (Test-Path $out) { "saved $out" } else { "TIMEOUT $Name" }
