# build/make-icon.ps1 — render the OpenShelf "OS" mark at several sizes.
# Palette comes from public/style.css: --bg #101418, --accent #4da3ff,
# --accent2 #7cc7ff, --border #2b3642. Output: build/icon/<size>.png
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot 'icon'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$sizes = 16, 24, 32, 48, 64, 128, 256

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  # Rounded-square plate.
  $pad = [Math]::Max(0, [int]($s * 0.04))
  $side = $s - 2 * $pad
  $r = [Math]::Max(2, [int]($s * 0.22))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($pad, $pad, $d, $d, 180, 90)
  $path.AddArc($pad + $side - $d, $pad, $d, $d, 270, 90)
  $path.AddArc($pad + $side - $d, $pad + $side - $d, $d, $d, 0, 90)
  $path.AddArc($pad, $pad + $side - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $plate = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 16, 20, 24))
  $g.FillPath($plate, $path)
  if ($s -ge 32) {
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 43, 54, 66), [Math]::Max(1, $s / 64))
    $g.DrawPath($pen, $path)
    $pen.Dispose()
  }

  # "OS" in the accent gradient.
  $fontSize = [single]($s * 0.52)
  $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, 0, $s, $s)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 77, 163, 255), [System.Drawing.Color]::FromArgb(255, 124, 199, 255), 45.0)
  # Nudge down slightly: cap-height centring looks high otherwise.
  $textRect = New-Object System.Drawing.RectangleF(0, [single]($s * 0.02), $s, $s)
  $g.DrawString('OS', $font, $brush, $textRect, $fmt)

  $brush.Dispose(); $fmt.Dispose(); $font.Dispose(); $plate.Dispose(); $path.Dispose(); $g.Dispose()
  $bmp.Save((Join-Path $outDir "$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

Write-Output "rendered $($sizes.Count) sizes into $outDir"
