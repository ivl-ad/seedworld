# icons07-tint.ps1 — sample worn-model tints (c/c2) from every item icon in icons07-map.csv and splice the
# TINT07 map into index.html between the TINT07-GEN sentinels. Rerun after changing the map or the sprites.
# c = mean of the DOMINANT HUE FAMILY among mid-luminance pixels (12 hue buckets + a grey bucket, most pixels
# wins) so a teal blade is not averaged into its brown handle; c2 = mean of dark pixels; dark-only sprites lighten.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -AssemblyName System.Drawing
$rows = Import-Csv (Join-Path $root 'icons07-map.csv') | Where-Object { $_.kind -eq 'item' -and $_.icon }
$entries = New-Object System.Collections.Generic.List[string]
$missing = 0
foreach ($r in $rows) {
  $f = Join-Path $root $r.icon
  if (-not (Test-Path $f)) { $missing++; continue }
  $bmp = New-Object System.Drawing.Bitmap($f)
  $bk = @{}; $d = @(0.0, 0.0, 0.0, 0)
  for ($y = 0; $y -lt $bmp.Height; $y++) { for ($x = 0; $x -lt $bmp.Width; $x++) {
    $p = $bmp.GetPixel($x, $y)
    if ($p.A -lt 200) { continue }
    $l = 0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B
    if ($l -lt 60 -or $l -gt 214) { if ($l -lt 60 -and $l -gt 8) { $d[0] += $p.R; $d[1] += $p.G; $d[2] += $p.B; $d[3]++ }; continue }
    $mx = [Math]::Max($p.R, [Math]::Max($p.G, $p.B)); $mn = [Math]::Min($p.R, [Math]::Min($p.G, $p.B)); $ch = $mx - $mn
    if ($ch -lt 26) { $key = 'grey' }
    else {
      if ($mx -eq $p.R) { $h = (($p.G - $p.B) / $ch) % 6 } elseif ($mx -eq $p.G) { $h = ($p.B - $p.R) / $ch + 2 } else { $h = ($p.R - $p.G) / $ch + 4 }
      $key = [int][Math]::Floor((($h * 60 + 360) % 360) / 30)
    }
    if (-not $bk[$key]) { $bk[$key] = @(0.0, 0.0, 0.0, 0) }
    $bk[$key][0] += $p.R; $bk[$key][1] += $p.G; $bk[$key][2] += $p.B; $bk[$key][3]++
  } }
  $bmp.Dispose()
  $win = $null; $winGrey = $false
  foreach ($e in $bk.GetEnumerator()) { if (-not $win -or $e.Value[3] -gt $win[3]) { $win = $e.Value; $winGrey = ($e.Key -eq 'grey') } }
  if (-not $win -and $d[3] -eq 0) { $missing++; continue }
  # a dark-but-chromatic sprite (dragon red, wine, black d'hide trim) hides its identity below the mid cut:
  # when grey wins the vote, defer to the lightened dark mean if that mean actually has a hue
  $useDark = -not $win
  if ($win -and $winGrey -and $d[3] -ge $win[3]) {
    $tr = $d[0] / $d[3]; $tg = $d[1] / $d[3]; $tb = $d[2] / $d[3]
    if (([Math]::Max($tr, [Math]::Max($tg, $tb)) - [Math]::Min($tr, [Math]::Min($tg, $tb))) -ge 16) { $useDark = $true }
  }
  if (-not $useDark) { $cr = [int]($win[0] / $win[3]); $cg = [int]($win[1] / $win[3]); $cb = [int]($win[2] / $win[3]) }
  else { $cr = [Math]::Min(255, [int]($d[0] / $d[3] * 1.75 + 16)); $cg = [Math]::Min(255, [int]($d[1] / $d[3] * 1.75 + 16)); $cb = [Math]::Min(255, [int]($d[2] / $d[3] * 1.75 + 16)) }
  if ($d[3] -gt 0) { $dr = [int]($d[0] / $d[3]); $dg = [int]($d[1] / $d[3]); $db = [int]($d[2] / $d[3]) }
  else { $dr = [int]($cr * 0.55); $dg = [int]($cg * 0.55); $db = [int]($cb * 0.55) }
  $entries.Add(("{0}:'{1:x2}{2:x2}{3:x2}.{4:x2}{5:x2}{6:x2}'" -f $r.id, $cr, $cg, $cb, $dr, $dg, $db))
}
$block = 'const TINT07 = { ' + ($entries -join ', ') + ' };'
$htmlPath = Join-Path $root 'index.html'
$html = [System.IO.File]::ReadAllText($htmlPath)
$re = [regex]'(?s)(/\* TINT07-GEN start \*/\n).*?(\n/\* TINT07-GEN end \*/)'
if (-not $re.IsMatch($html)) { throw 'TINT07-GEN sentinels not found' }
[System.IO.File]::WriteAllText($htmlPath, $re.Replace($html, ('$1' + $block.Replace('$', '$$') + '$2'), 1))
"{0} tints spliced ({1:n1} KB), {2} skipped" -f $entries.Count, ($block.Length / 1KB), $missing