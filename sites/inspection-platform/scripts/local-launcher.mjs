// Local Windows entry point. No publishing, uploads, or data-directory changes.
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,existsSync,unlinkSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureCnnReceiver} from './start-cnn-receiver.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const runtime=path.join(root,'.sites-runtime');mkdirSync(runtime,{recursive:true});
const pidFile=path.join(runtime,'local-platform.json');
const startupLock=path.join(runtime,'local-platform-starting.json');
const projectLock=path.join(root,'.vinext','dev','lock.json');
const entry=path.join(root,'scripts','run-framework.mjs');
const serviceEntry=path.join(root,'scripts','local-service.ps1');
const defaultPort=5317;
const noOpen=process.argv.includes('--no-open')||process.env.MICROINSPECT_NO_OPEN==='1';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const readJSON=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
function alive(pid){try{if(!Number.isSafeInteger(pid)||pid<1)return false;process.kill(pid,0);return true;}catch{return false;}}
function owns(pid){
 if(!alive(pid))return false;
 const code='$p=Get-CimInstance Win32_Process -Filter ("ProcessId = " + $env:MICROINSPECT_PID); if($p -and $p.CommandLine -and ($p.CommandLine.Contains($env:MICROINSPECT_ENTRY) -or $p.CommandLine.Contains($env:MICROINSPECT_SERVICE))){[Console]::Write("owned")}';
 return spawnSync('powershell.exe',['-NoProfile','-Command',code],{windowsHide:true,encoding:'utf8',env:{...process.env,MICROINSPECT_ENTRY:entry,MICROINSPECT_SERVICE:serviceEntry,MICROINSPECT_PID:String(pid)}}).stdout?.trim()==='owned';
}
function startWindowsService(port){
 const code=`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$exe=Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$line='"'+$exe+'" -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$env:MICROINSPECT_SERVICE+'" -NodePath "'+$env:MICROINSPECT_NODE+'" -ProjectRoot "'+$env:MICROINSPECT_ROOT+'" -Port '+$env:MICROINSPECT_PORT
$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$line;CurrentDirectory=$env:MICROINSPECT_ROOT;ProcessStartupInformation=$startup}|Select-Object ReturnValue,ProcessId|ConvertTo-Json
`;
 const result=spawnSync('powershell.exe',['-NoProfile','-Command',code],{windowsHide:true,encoding:'utf8',env:{...process.env,
  MICROINSPECT_NODE:process.execPath,MICROINSPECT_SERVICE:serviceEntry,MICROINSPECT_ROOT:path.resolve(root),MICROINSPECT_PORT:String(port)}});
 if(result.status!==0)throw new Error('无法启动独立后台：'+(result.stderr?.trim()||'Windows进程服务不可用'));
 const created=JSON.parse(result.stdout.replace(/^\uFEFF/,''));
 if(created.ReturnValue!==0||!Number.isSafeInteger(created.ProcessId))throw new Error('Windows未能启动本机后台，错误码：'+created.ReturnValue);
 return created.ProcessId;
}
function activeProject(){
 const item=readJSON(projectLock);
 if(!item||!Number.isInteger(item.port)||item.port<1024||item.port>65535||!alive(item.pid))return null;
 if(typeof item.cwd!=='string'||path.resolve(item.cwd).toLowerCase()!==path.resolve(root).toLowerCase())return null;
 if(!['127.0.0.1','localhost','::1'].includes(item.hostname))return null;
 return item;
}
async function healthy(port){
 try{
  const response=await fetch(`http://127.0.0.1:${port}/api/status`,{signal:AbortSignal.timeout(1800)});
  const body=await response.json();
  return (response.status===401&&body.error==='请先登录')||
    (response.status===200&&body.storage==='local'&&typeof body.cloudReady==='boolean');
 }catch{return false;}
}
function openPlatform(port){
 try{ensureCnnReceiver(port);}catch(error){
  writeFileSync(path.join(runtime,'cnn-receiver-launch-error.txt'),`${new Date().toISOString()}\n${error.stack??error}\n`);
  console.error(error.message);
 }
 const url=`http://127.0.0.1:${port}/signin-with-chatgpt?return_to=/`;
 console.log(`Local platform ready: http://127.0.0.1:${port}/`);
 if(!noOpen){
  const browser=spawn('cmd.exe',['/c','start','',url],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>console.error(error.message));browser.unref();
 }
}
function acquireStartup(){
 try{
  const fd=openSync(startupLock,'wx');
  writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:Date.now()}));closeSync(fd);
  return true;
 }catch(error){
  if(error.code!=='EEXIST')throw error;
  const lock=readJSON(startupLock);
  if(!alive(lock?.pid)||Date.now()-statSync(startupLock).mtimeMs>180000){try{unlinkSync(startupLock);}catch{}}
  return false;
 }
}
async function main(){
 let state=readJSON(pidFile);
 if(process.argv.includes('--stop')){
  const target=state&&owns(state.pid)?state:activeProject();
  if(target&&alive(target.pid)){
   if(!owns(target.pid))throw new Error('无法确认服务进程所属。请关闭原来的平台启动窗口。');
   const result=spawnSync('taskkill.exe',['/PID',String(target.pid),'/T','/F'],{windowsHide:true,encoding:'utf8'});
   if(result.status!==0)throw new Error('未能关闭本机平台，请查看启动日志。');
  }
  if(existsSync(pidFile))unlinkSync(pidFile);
  console.log('Local platform stopped. Saved images and records are retained.');return;
 }
 // A healthy service takes precedence over a stale PID file or duplicate click.
 const running=activeProject();
 if(running&&await healthy(running.port)){openPlatform(running.port);return;}
 if(await healthy(defaultPort)){openPlatform(defaultPort);return;}
 const deadline=Date.now()+90000;
 let ownsStartup=false;
 try{
  while(Date.now()<deadline){
   const existing=activeProject();
   if(existing&&await healthy(existing.port)){openPlatform(existing.port);return;}
   if(!ownsStartup)ownsStartup=acquireStartup();
   if(ownsStartup)break;
   await sleep(500);
  }
  if(!ownsStartup)throw new Error('平台仍在启动，请稍后再次双击。');
  let existing=activeProject();
  // A Vite process can outlive its native backend. Recover only our own server.
  if(existing&&Date.now()-existing.startedAt>30000){
   const recovery=state&&owns(state.pid)?state:existing;
   if(owns(recovery.pid)){
    const result=spawnSync('taskkill.exe',['/PID',String(recovery.pid),'/T','/F'],{windowsHide:true,encoding:'utf8'});
    if(result.status!==0)throw new Error('原后台没有响应，且未能自动重新启动。');
    existing=null;await sleep(500);
   }
  }
  let port=existing?.port??defaultPort;
  let child,childError;
  if(!existing){
   if(process.platform==='win32'){
    state={pid:startWindowsService(port),port,startedAt:new Date().toISOString(),kind:'windows-process-broker'};
    writeFileSync(pidFile,JSON.stringify(state));
   }else{
   const output=openSync(path.join(runtime,'local-platform.log'),'a');
   const errors=openSync(path.join(runtime,'local-platform-error.log'),'a');
   try{
    child=spawn(process.execPath,[entry,'dev','--hostname','127.0.0.1','--port',String(port)],{
     cwd:root,detached:true,windowsHide:true,stdio:['ignore',output,errors],
     env:{...process.env,PATH:path.dirname(process.execPath)+';'+process.env.PATH}
    });
   }finally{closeSync(output);closeSync(errors);}
   child.on('error',error=>{childError=error;});child.unref();
   if(!Number.isSafeInteger(child.pid))throw new Error('无法启动平台服务。');
   state={pid:child.pid,port,startedAt:new Date().toISOString()};
   writeFileSync(pidFile,JSON.stringify(state));
   }
  }
  while(Date.now()<deadline){
   const current=activeProject();if(current)port=current.port;
   if(await healthy(port)){openPlatform(port);return;}
   if(childError)throw childError;
   if(child&&child.exitCode!==null)throw new Error('平台启动失败，可能已有其他程序占用端口。');
   if(!existing&&state&&!alive(state.pid))throw new Error('平台后台已退出，请查看 .sites-runtime/server-stderr.log。');
   if(existing&&!alive(existing.pid))throw new Error('原平台服务已退出，请重新双击启动。');
   await sleep(500);
  }
  throw new Error('平台启动超过90秒，请查看日志或重新双击启动。');
 }finally{
  if(ownsStartup&&readJSON(startupLock)?.pid===process.pid){try{unlinkSync(startupLock);}catch{}}
 }
}
main().catch(error=>{
 const log=path.join(runtime,'launcher-error.txt');
 writeFileSync(log,`${new Date().toISOString()}\n${error.stack??error}\n`);console.error(error.message);
 if(!noOpen){
  const code='Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:MICROINSPECT_ERROR,"微检平台启动提示") | Out-Null';
  spawnSync('powershell.exe',['-NoProfile','-Command',code],{windowsHide:true,env:{...process.env,MICROINSPECT_ERROR:`${error.message}\n日志：${log}`}});
 }
 process.exitCode=1;
});
