// Install a local desktop entry; application and stored data stay in this project.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const launcher=path.join(root,'scripts','local-launcher.mjs');
const icon=path.join(root,'public','platform.ico');
const script=`
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$desktop=[Environment]::GetFolderPath('DesktopDirectory')
$shell=New-Object -ComObject WScript.Shell
$linkPath=Join-Path $desktop ($env:MICROINSPECT_LABEL + '.lnk')
$link=$shell.CreateShortcut($linkPath)
$link.TargetPath=Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$nodeLiteral=$env:MICROINSPECT_NODE.Replace("'","''")
$launcherLiteral=$env:MICROINSPECT_LAUNCHER.Replace("'","''")
$link.Arguments='-NoProfile -WindowStyle Hidden -Command "& '''+$nodeLiteral+''' '''+$launcherLiteral+'''"'
$link.WorkingDirectory=$env:MICROINSPECT_ROOT
$link.Description=$env:MICROINSPECT_DESCRIPTION
$link.IconLocation=$env:MICROINSPECT_ICON+',0'
$link.WindowStyle=7
$link.Save()
$saved=$shell.CreateShortcut($linkPath)
[PSCustomObject]@{path=$linkPath;target=$saved.TargetPath;arguments=$saved.Arguments;workingDirectory=$saved.WorkingDirectory;icon=$saved.IconLocation}|ConvertTo-Json
`;
const result=spawnSync('powershell.exe',['-NoProfile','-Command',script],{
 windowsHide:true,encoding:'utf8',env:{...process.env,
  MICROINSPECT_NODE:process.execPath,MICROINSPECT_LAUNCHER:launcher,MICROINSPECT_ROOT:root,
  MICROINSPECT_LABEL:'微检零件检测平台',MICROINSPECT_DESCRIPTION:'双击启动本机服务并打开零件检测平台。',MICROINSPECT_ICON:icon}
});
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
process.exitCode=result.status??1;
