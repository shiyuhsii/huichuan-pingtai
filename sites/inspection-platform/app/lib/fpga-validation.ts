import type { FpgaCaptureMetadata, FpgaStatus } from './types';
import { cleanText, InputError, validateBoxes } from './validation';

export const FPGA_IMAGE_LIMIT = 5 * 1024 * 1024;
export const FPGA_HEARTBEAT_TIMEOUT = 15000;
const identities = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function object(value:unknown,label:string):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new InputError(`${label}必须是对象`);
 return value as Record<string,unknown>;
}
function identity(value:unknown,label:string,max:number):string {
 const text=cleanText(value,label,max);
 if(!identities.test(text))throw new InputError(`${label}仅支持字母、数字、点、下划线、冒号和短横线`);
 return text;
}
function optionalText(value:unknown,label:string,max:number):string|undefined {
 return value===undefined?undefined:cleanText(value,label,max);
}
export function validateCaptureMetadata(value:unknown):FpgaCaptureMetadata {
 const m=object(value,'采集元数据');
 const allowed=new Set(['version','source','deviceId','sessionId','frameId','capturedAt','width','height','partId','batchId','build','partCount','boxes','boxesSource','sha256','resultOriginal','captureKind','originalAvailable','sourceProtocol','scratchCount']);
 if(Object.keys(m).some(key=>!allowed.has(key)))throw new InputError('采集元数据包含不支持的字段');
 if(m.version!==1||m.source!=='fpga-cnn')throw new InputError('仅接受版本1的FPGA CNN采集');
 const deviceId=identity(m.deviceId,'设备编号',80),sessionId=identity(m.sessionId,'会话编号',100),frameId=identity(m.frameId,'帧编号',100);
 const captured=cleanText(m.capturedAt,'采集时间',40);
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(captured)||!Number.isFinite(Date.parse(captured)))throw new InputError('采集时间必须是UTC ISO时间');
 const capturedAt=new Date(captured).toISOString();
 if(capturedAt.slice(0,19)!==captured.slice(0,19))throw new InputError('采集日期不正确');
 for(const key of ['width','height'] as const)if(!Number.isInteger(m[key])||Number(m[key])<1||Number(m[key])>4096)throw new InputError('采集图片尺寸必须在1到4096之间');
 const width=m.width as number,height=m.height as number;
 if(width*height>8000000)throw new InputError('采集图片不能超过800万像素');
 const captureKind=m.captureKind??'separate-images';
 if(captureKind!=='paired-display'&&captureKind!=='separate-images')throw new InputError('采集图片类型不受支持');
 const paired=captureKind==='paired-display';
 if(paired&&(m.originalAvailable!==false||m.sourceProtocol!=='VFAUTO1'))throw new InputError('拼接检测截图需要明确标记原图不可用及VFAUTO1协议');
 if(!paired&&m.originalAvailable!==undefined&&m.originalAvailable!==true)throw new InputError('三图采集必须包含独立原图');
 if(m.boxesSource!==undefined&&(!paired||m.boxesSource!=='display-overlay'))throw new InputError('截图框来源必须明确标记为display-overlay');
 const hashes=object(m.sha256,'图片校验值');
 const sha256:Record<string,string>={};
 const names=paired?['result'] as const:['original','result','edges'] as const;
 if(Object.keys(hashes).some(key=>!(names as readonly string[]).includes(key)))throw new InputError('采集图片与校验字段不一致');
 for(const key of names){
  if(typeof hashes[key]!=='string'||!/^[a-f0-9]{64}$/i.test(hashes[key] as string))throw new InputError('三张图片都需要SHA256校验值');
  sha256[key]=(hashes[key] as string).toLowerCase();
 }
 if(!Array.isArray(m.boxes))throw new InputError('缺少CNN检测框数组');
 if(paired&&m.boxes.length&&m.boxesSource!=='display-overlay')throw new InputError('VFAUTO1不提供独立框坐标，截图提取框需要标明display-overlay来源');
 const boxes=validateBoxes(m.boxes.map((raw:unknown)=>{
  const b=object(raw,'CNN检测框');return {...b,label:'pending',note:'',origin:'fpga'};
 })).map((box,index)=>{
  const raw=m.boxes as Record<string,unknown>[];const score=raw[index].score;
  if(score!==undefined&&(typeof score!=='number'||!Number.isFinite(score)||score<0||score>1))throw new InputError('CNN置信度必须在0到1之间');
  if(paired&&(score!==undefined||box.x+box.w>.500001))throw new InputError('截图提取框只取左侧灰度图，不能包含模型置信度或重复的右侧框');
  const {id,x,y,w,h}=box;return {id,x,y,w,h,...(score===undefined?{}:{score:score as number})};
 });
 if(m.partCount!==undefined&&(!Number.isInteger(m.partCount)||Number(m.partCount)<0||Number(m.partCount)>100000))throw new InputError('零件数量不正确');
 if(m.scratchCount!==undefined&&(!Number.isInteger(m.scratchCount)||Number(m.scratchCount)<0||Number(m.scratchCount)>32))throw new InputError('设备划痕计数不正确');
 if(paired&&(m.scratchCount===undefined||Number(m.scratchCount)<1))throw new InputError('VFAUTO1检测截图缺少有效的设备划痕计数');
 if(paired&&boxes.length>Number(m.scratchCount))throw new InputError('截图提取框数量超过设备上报候选数量');
 if(m.resultOriginal!==undefined&&m.resultOriginal!==true)throw new InputError('设备结果图必须保留首次CNN结果');
 const base={version:1 as const,source:'fpga-cnn' as const,deviceId,sessionId,frameId,capturedAt,width,height,partId:optionalText(m.partId,'零件编号',100),batchId:optionalText(m.batchId,'批次',100),build:optionalText(m.build,'固件版本',120),partCount:m.partCount as number|undefined,boxes,resultOriginal:true as const};
 if(paired)return {...base,captureKind:'paired-display',originalAvailable:false,sourceProtocol:'VFAUTO1',scratchCount:m.scratchCount as number,...(m.boxesSource==='display-overlay'?{boxesSource:'display-overlay' as const}:{}),sha256:{result:sha256.result}};
 return {...base,captureKind:'separate-images',originalAvailable:true,sourceProtocol:optionalText(m.sourceProtocol,'回传协议',100),scratchCount:m.scratchCount as number|undefined,sha256:{original:sha256.original,result:sha256.result,edges:sha256.edges}};
}

export async function sha256Hex(bytes:Uint8Array):Promise<string> {
 const digest=await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>);
 return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
}
export function captureIdentity(metadata:FpgaCaptureMetadata):string {
 return JSON.stringify([metadata.source,metadata.deviceId,metadata.sessionId,metadata.frameId]);
}

const crcTable=Uint32Array.from({length:256},(_,n)=>{
 let crc=n;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;
});
function crc32(bytes:Uint8Array,start:number,end:number):number {
 let crc=0xffffffff;for(let at=start;at<end;at++)crc=crcTable[(crc^bytes[at])&255]^(crc>>>8);return (crc^0xffffffff)>>>0;
}
const invalidPng=():never=>{throw new InputError('采集PNG不完整或编码不受支持，请重新传输');};

/** This protocol accepts bounded, non-interlaced 8-bit L/RGB/RGBA PNGs only.
 * CRCs and decompressed scanline lengths are checked before any storage write.
 * No arbitrary filesystem path or image URL is ever fetched by the importer. */
export async function validateCapturePng(bytes:Uint8Array,width:number,height:number):Promise<void> {
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>4096||height>4096||width*height>8000000)return invalidPng();
 if(!bytes.length||bytes.length>FPGA_IMAGE_LIMIT)throw new InputError('每张采集图片必须在5MB以内',413);
 if(bytes.length<45||![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return invalidPng();
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);
 const idats:Uint8Array[]=[];let channels=0,finished=false,sawIdat=false,idatEnded=false,sawPalette=false;
 for(let at=8;at<bytes.length;){
  if(at+12>bytes.length)return invalidPng();
  const size=view.getUint32(at),end=at+12+size;
  if(end>bytes.length||size>0x7fffffff)return invalidPng();
  const kind=String.fromCharCode(...bytes.subarray(at+4,at+8));
  if(!/^[A-Za-z]{4}$/.test(kind)||crc32(bytes,at+4,end-4)!==view.getUint32(end-4))return invalidPng();
  if(at===8){
   if(kind!=='IHDR'||size!==13||view.getUint32(at+8)!==width||view.getUint32(at+12)!==height||bytes[at+16]!==8||bytes[at+18]!==0||bytes[at+19]!==0||bytes[at+20]!==0)return invalidPng();
   channels=({0:1,2:3,6:4} as Record<number,number>)[bytes[at+17]];
   if(!channels)return invalidPng();
  }else if(kind==='IHDR'||kind==='eXIf'||kind==='acTL'||kind==='fcTL'||kind==='fdAT')return invalidPng();
  if(kind==='PLTE'){
   if(sawPalette||sawIdat||!size||size>768||size%3)return invalidPng();sawPalette=true;
  }
  if(kind==='IDAT'){
   if(idatEnded)return invalidPng();sawIdat=true;idats.push(bytes.subarray(at+8,end-4));
  }else{
   if(sawIdat)idatEnded=true;
   if(kind==='IEND'){
    if(size!==0||!sawIdat||end!==bytes.length)return invalidPng();finished=true;break;
   }
   // Unknown critical chunks can alter pixel interpretation; ancillary chunks
   // are allowed after their CRC is checked. Palette data is irrelevant here.
   if(at!==8&&kind!=='PLTE'&&kind[0]===kind[0].toUpperCase())return invalidPng();
  }
  at=end;
 }
 if(!finished||!idats.reduce((n,chunk)=>n+chunk.length,0))return invalidPng();
 const stride=width*channels+1,expected=height*stride;
 const stream=new Blob(idats as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'));
 const reader=stream.getReader();let length=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   if(length+value.length>expected){await reader.cancel();return invalidPng();}
   let at=(stride-(length%stride))%stride;
   for(;at<value.length;at+=stride)if(value[at]>4){await reader.cancel();return invalidPng();}
   length+=value.length;
  }
 }catch(error){if(error instanceof InputError)throw error;return invalidPng();}
 finally{reader.releaseLock();}
 if(length!==expected)return invalidPng();
}

export function validateFpgaStatus(value:unknown):Omit<FpgaStatus,'updatedAt'|'stale'> {
 const s=object(value,'设备状态');
 const connections=new Set(['disconnected','searching','connected','receiving','error']);
 if(typeof s.connection!=='string'||!connections.has(s.connection))throw new InputError('设备连接状态不正确');
 if(typeof s.handshake!=='boolean')throw new InputError('缺少设备握手状态');
 if((s.connection==='connected'||s.connection==='receiving')&&!s.handshake)throw new InputError('尚未与板卡握手，不能标为已连接');
 if((s.connection==='disconnected'||s.connection==='searching')&&s.handshake)throw new InputError('设备未连接时握手状态必须为false');
 if(!['idle','pending','synced','error'].includes(s.sync as string))throw new InputError('同步状态不正确');
 const progress=s.progress??0;if(typeof progress!=='number'||!Number.isFinite(progress)||progress<0||progress>100)throw new InputError('传输进度必须在0到100之间');
 return {connection:s.connection as FpgaStatus['connection'],handshake:s.handshake,port:optionalText(s.port,'串口名称',100),build:optionalText(s.build,'固件版本',120),message:optionalText(s.message,'设备提示',1000),progress,archivePath:optionalText(s.archivePath,'归档位置',1000),sync:s.sync as FpgaStatus['sync'],lastCaptureId:optionalText(s.lastCaptureId,'最近采集编号',100)};
}
export function effectiveFpgaStatus(value:Omit<FpgaStatus,'stale'>|null,now=Date.now()):FpgaStatus {
 if(!value)return {connection:'disconnected',handshake:false,progress:0,sync:'idle',updatedAt:null,stale:true,message:'接收程序尚未连接'};
 const age=now-Date.parse(value.updatedAt??'');const stale=!Number.isFinite(age)||age>FPGA_HEARTBEAT_TIMEOUT||age<0;
 if(stale)return {...value,connection:'disconnected',handshake:false,progress:0,stale:true,message:'接收程序心跳已超时，请检查接收程序和连接'};
 return {...value,stale:false};
}
