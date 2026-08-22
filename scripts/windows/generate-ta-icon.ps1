param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\build-resources')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = [System.Collections.Generic.List[byte[]]]::new()

foreach ($size in $sizes) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear([System.Drawing.Color]::FromArgb(29, 36, 44))

    $borderPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(83, 94, 106), [Math]::Max(1, $size / 128))
    $font = [System.Drawing.Font]::new('Segoe UI', [Math]::Max(7, $size * 0.38), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $format = [System.Drawing.StringFormat]::new()
    try {
      $graphics.DrawRectangle($borderPen, 0, 0, $size - 1, $size - 1)
      $format.Alignment = [System.Drawing.StringAlignment]::Center
      $format.LineAlignment = [System.Drawing.StringAlignment]::Center
      $textArea = [System.Drawing.RectangleF]::new(0, 0, $size, $size)
      $graphics.DrawString('TA', $font, $textBrush, $textArea, $format)
    } finally {
      $format.Dispose()
      $textBrush.Dispose()
      $font.Dispose()
      $borderPen.Dispose()
    }

    $stream = [System.IO.MemoryStream]::new()
    try {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $images.Add($stream.ToArray())
      if ($size -eq 256) {
        [System.IO.File]::WriteAllBytes((Join-Path $resolvedOutput 'ta-icon.png'), $stream.ToArray())
      }
    } finally {
      $stream.Dispose()
    }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

$iconPath = Join-Path $resolvedOutput 'ta-icon.ico'
$file = [System.IO.File]::Create($iconPath)
$writer = [System.IO.BinaryWriter]::new($file)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$sizes.Count)
  $offset = 6 + (16 * $sizes.Count)
  for ($index = 0; $index -lt $sizes.Count; $index++) {
    $size = $sizes[$index]
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$index].Length)
    $writer.Write([uint32]$offset)
    $offset += $images[$index].Length
  }
  foreach ($image in $images) { $writer.Write($image) }
} finally {
  $writer.Dispose()
  $file.Dispose()
}

Write-Output $iconPath
