# Crops a region of a screenshot (for close inspection) and optionally scales it up.
#   powershell -File tools/crop.ps1 -In shots/a.png -Out shots/a_crop.png -X 0 -Y 0 -W 400 -H 225 [-Scale 2]
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$X = 0, [int]$Y = 0, [int]$W = 400, [int]$H = 225, [double]$Scale = 2
)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $In))
$dw = [int]($W * $Scale); $dh = [int]($H * $Scale)
$dst = New-Object System.Drawing.Bitmap $dw, $dh
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $dw, $dh), (New-Object System.Drawing.Rectangle $X, $Y, $W, $H), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose(); $src.Dispose()
$dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $dst.Dispose()
"wrote $Out"
