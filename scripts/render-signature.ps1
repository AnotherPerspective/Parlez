# Draws the Parlez! panel's signature, "Parlez! by Another Perspective", as
# jsx/panel-images/firma.png: grey on transparent, 20 px high, Segoe UI 9 pt.
# The panel shows it on its signature button when the file is there, and the
# text otherwise. Windows only (System.Drawing). Run from the repository:
#   powershell -NoProfile -File scripts/render-signature.ps1
# (an execution policy that blocks local scripts needs the user's own
# decision: -ExecutionPolicy Bypass for this one run).

Add-Type -AssemblyName System.Drawing
$text = "Parlez! by Another Perspective"
$font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
$probe = New-Object System.Drawing.Bitmap(1, 1)
$g0 = [System.Drawing.Graphics]::FromImage($probe)
$size = $g0.MeasureString($text, $font)
$g0.Dispose(); $probe.Dispose()
$w = [int][Math]::Ceiling($size.Width) + 2
$h = 20
$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Transparent)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 140, 140, 140))
$y = [int](($h - $size.Height) / 2)
$g.DrawString($text, $font, $brush, 1, $y)
$g.Dispose()
$out = if ($args.Count -gt 0) { $args[0] } else { Join-Path $PSScriptRoot "../jsx/panel-images/firma.png" }
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"{0}x{1} {2} bytes" -f $w, $h, (Get-Item $out).Length
