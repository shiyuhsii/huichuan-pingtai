param([string]$NodePath,[string]$ProjectRoot,[int]$Port=5317)
# Launched by Windows' process broker, independently of terminal/session jobs.
$ErrorActionPreference='Stop'
$runtime=Join-Path $ProjectRoot '.sites-runtime'
$entry=Join-Path $ProjectRoot 'scripts\run-framework.mjs'
$env:PATH=(Split-Path -Parent $NodePath)+';'+$env:PATH
$arguments='"'+$entry+'" dev --hostname 127.0.0.1 --port '+$Port
$child=Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'server-stdout.log') -RedirectStandardError (Join-Path $runtime 'server-stderr.log') -PassThru
$child.WaitForExit()
exit $child.ExitCode
