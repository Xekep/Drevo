param(
  [Parameter(Mandatory = $true)][string]$SshConfig,
  [Parameter(Mandatory = $true)][string]$Destination,
  [string]$RemoteHost = 'terraz-web-root'
)
$ErrorActionPreference = 'Stop'
$backupRoot = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$remoteQuery = @'
from pathlib import Path
import json
root = Path('/var/www/drevo.kiiko.ru/shared/backups')
ready = sorted((p for p in root.glob('full-*.tar.gz') if Path(str(p) + '.sha256').is_file()), key=lambda p:p.name)
if not ready: raise SystemExit('No completed backup')
p = ready[-1]
print(json.dumps({'name': p.name, 'sha256': Path(str(p)+'.sha256').read_text().split()[0]}))
'@
$metadataText = $remoteQuery | & ssh -F $SshConfig -o BatchMode=yes -o ConnectTimeout=20 $RemoteHost 'python3 -'
if ($LASTEXITCODE -ne 0) { throw 'Could not locate a completed server backup' }
$metadata = $metadataText | ConvertFrom-Json
if ($metadata.name -notmatch '^full-\d{8}T\d{6}Z(?:-[a-f0-9-]{36})?\.tar\.gz$' -or $metadata.sha256 -notmatch '^[a-f0-9]{64}$') {
  throw 'Invalid backup metadata'
}
$target = Join-Path $backupRoot $metadata.name
$partial = "$target.partial"
try {
  if (!(Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $metadata.sha256) {
    & scp -F $SshConfig -o BatchMode=yes -o ConnectTimeout=20 "${RemoteHost}:/var/www/drevo.kiiko.ru/shared/backups/$($metadata.name)" $partial
    if ($LASTEXITCODE -ne 0) { throw 'Backup download failed' }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $metadata.sha256) { throw 'Backup checksum mismatch' }
    Move-Item -LiteralPath $partial -Destination $target -Force
  }
  "$($metadata.sha256)  $($metadata.name)" | Set-Content -LiteralPath "$target.sha256" -Encoding ASCII
  @{ backup = $metadata.name; checkedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupRoot 'last-success.json') -Encoding UTF8
  Get-ChildItem -LiteralPath $backupRoot -File | Where-Object {
    $_.Name -match '^full-\d{8}T\d{6}Z(?:-[a-f0-9-]{36})?\.tar\.gz(\.sha256)?$' -and $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-30) -and !$_.Name.StartsWith($metadata.name)
  } | ForEach-Object { Remove-Item -LiteralPath $_.FullName }
  Write-Output "Verified backup: $target"
} finally {
  if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
}
