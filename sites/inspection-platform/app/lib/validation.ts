import type { InspectionBox, QualityMetrics, ReviewLabel } from './types';
const labels = new Set(['pending','scratch','normal-hole','joint','shadow','uncertain']);
export class InputError extends Error { constructor(message:string, public status=400){super(message);} }
export function cleanText(value:unknown, label:string, max=120):string {
  if(typeof value!=='string' || value.length>max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new InputError(`${label}格式不正确或过长`);
  return value.trim();
}
export function reviewLabel(value:unknown):ReviewLabel {if(typeof value!=='string'||!labels.has(value)) throw new InputError('复核标签不正确');return value as ReviewLabel;}
export function validateBoxes(value:unknown):InspectionBox[] {
  if(!Array.isArray(value)||value.length>64) throw new InputError('最多保存64个检测区域');
  const ids=new Set<string>();
  return value.map(b=>{
    if(!b||typeof b!=='object') throw new InputError('检测框格式不正确');
    const id=cleanText(b.id,'检测框编号',80);if(!id||ids.has(id))throw new InputError('检测框编号重复或为空');ids.add(id);
    for(const k of ['x','y','w','h']) if(typeof b[k]!=='number'||!Number.isFinite(b[k])||b[k]<0||b[k]>1) throw new InputError('检测框坐标必须在0到1之间');
    if(b.w<=0||b.h<=0||b.x+b.w>1.000001||b.y+b.h>1.000001)throw new InputError('检测框超出图片范围');
    if(b.removed!==undefined&&typeof b.removed!=='boolean')throw new InputError('区域移除状态必须是布尔值');
    return {id,x:b.x,y:b.y,w:b.w,h:b.h,label:reviewLabel(b.label),note:cleanText(b.note??'','区域备注',2000),origin:b.origin==='fpga'?'fpga':b.origin==='example'?'example':'manual',...(b.removed===undefined?{}:{removed:b.removed})};
  });
}
export function validateQuality(q:unknown):QualityMetrics {
  const v=q as QualityMetrics;
  if(!v||typeof v!=='object') throw new InputError('缺少拍摄质量检查结果');
  for(const [k,max] of [['brightness',255],['darkRatio',1],['brightRatio',1],['sharpness',10000000]] as const){if(typeof v[k]!=='number'||!Number.isFinite(v[k])||v[k]<0||v[k]>max)throw new InputError('质量检查数值不正确');}
  if(v.darkRatio+v.brightRatio>1.000001)throw new InputError('亮部与暗部比例之和不能超过100%');
  if(!['good','review','retake'].includes(v.verdict)||!Array.isArray(v.warnings)||v.warnings.length>12)throw new InputError('质量检查格式不正确');
  return {brightness:v.brightness,darkRatio:v.darkRatio,brightRatio:v.brightRatio,sharpness:v.sharpness,verdict:v.verdict,warnings:v.warnings.map(s=>cleanText(s,'质量提示',300))};
}
type Dimensions = {width:number;height:number};
const invalidImage = ():never => {throw new InputError('图片结构不完整或格式不正确，请重新选择可正常打开的图片');};
function fourCC(data:Uint8Array,at:number):string {return String.fromCharCode(...data.subarray(at,at+4));}

// EXIF is optional metadata. A broken offset is ignored rather than read outside
// the APP1/eXIf/EXIF chunk. The browser performs the actual pixel orientation.
function exifOrientation(data:Uint8Array):number {
 const start=data.length>=6&&fourCC(data,0)==='Exif'&&data[4]===0&&data[5]===0?6:0;
 if(data.length-start<8)return 1;
 const d=new DataView(data.buffer,data.byteOffset+start,data.length-start);
 const little=d.getUint16(0)===0x4949;
 if(!little&&d.getUint16(0)!==0x4d4d)return 1;
 if(d.getUint16(2,little)!==42)return 1;
 const ifd=d.getUint32(4,little);
 if(ifd<8||ifd+2>d.byteLength)return 1;
 const count=d.getUint16(ifd,little);
 if(ifd+2+count*12>d.byteLength)return 1;
 for(let i=0;i<count;i++){
  const p=ifd+2+i*12;
  if(d.getUint16(p,little)===0x0112&&d.getUint16(p+2,little)===3&&d.getUint32(p+4,little)===1){
   const orientation=d.getUint16(p+8,little);return orientation>=1&&orientation<=8?orientation:1;
  }
 }
 return 1;
}
function orient(size:Dimensions,orientation:number):Dimensions {return orientation>=5&&orientation<=8?{width:size.height,height:size.width}:size;}

function pngDimensions(data:Uint8Array):Dimensions {
 if(data.length<33||![137,80,78,71,13,10,26,10].every((v,i)=>data[i]===v))return invalidImage();
 const d=new DataView(data.buffer,data.byteOffset,data.byteLength);
 let p=8,width=0,height=0,idatBytes=0,orientation=1;
 while(p+12<=data.length){
  const length=d.getUint32(p);const kind=fourCC(data,p+4);const end=p+12+length;
  if(end>data.length||length>0x7fffffff)return invalidImage();
  if(p===8){
   if(kind!=='IHDR'||length!==13)return invalidImage();
   width=d.getUint32(p+8);height=d.getUint32(p+12);
   const depths:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
   if(!depths[data[p+17]]?.includes(data[p+16])||data[p+18]!==0||data[p+19]!==0||data[p+20]>1)return invalidImage();
  }else if(kind==='IHDR')return invalidImage();
  if(kind==='IDAT')idatBytes+=length;
  if(kind==='eXIf')orientation=exifOrientation(data.subarray(p+8,p+8+length));
  if(kind==='IEND'){
   if(length!==0||!idatBytes)return invalidImage();
   return orient({width,height},orientation);
  }
  p=end;
 }
 return invalidImage();
}

function jpegDimensions(data:Uint8Array):Dimensions {
 if(data.length<4||data[0]!==255||data[1]!==216)return invalidImage();
 const d=new DataView(data.buffer,data.byteOffset,data.byteLength);
 let p=2,width=0,height=0,orientation=1,inScan=false,sawScan=false,scanBytes=0;
 while(p<data.length){
  if(inScan){
   if(data[p]!==255){scanBytes++;p++;continue;}
   if(p+1>=data.length)return invalidImage();
   if(data[p+1]===0){scanBytes++;p+=2;continue;}
   if(data[p+1]>=208&&data[p+1]<=215){p+=2;continue;}
   // A marker terminates this scan; progressive JPEG may start another one.
   inScan=false;
  }
  if(data[p++]!==255)return invalidImage();
  while(p<data.length&&data[p]===255)p++;
  if(p>=data.length)return invalidImage();
  const marker=data[p++];
  if(marker===217){if(!width||!height||!sawScan||!scanBytes)return invalidImage();return orient({width,height},orientation);}
  if(marker===0||marker===216)return invalidImage();
  if(marker===1||(marker>=208&&marker<=215))continue;
  if(p+2>data.length)return invalidImage();
  const length=d.getUint16(p);
  if(length<2||p+length>data.length)return invalidImage();
  if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
   if(length<11||!data[p+7]||length!==8+3*data[p+7])return invalidImage();
   height=d.getUint16(p+3);width=d.getUint16(p+5);
  }
  if(marker===225&&length>=8&&fourCC(data,p+2)==='Exif')orientation=exifOrientation(data.subarray(p+2,p+length));
  if(marker===218){
   if(!width||!height||length<8||!data[p+2]||length!==6+2*data[p+2])return invalidImage();
   sawScan=true;inScan=true;
  }
  p+=length;
 }
 return invalidImage();
}

function webpBitstream(data:Uint8Array,kind:string):Dimensions {
 const d=new DataView(data.buffer,data.byteOffset,data.byteLength);
 if(kind==='VP8 '){
  if(data.length<=10||data[0]&1||data[3]!==157||data[4]!==1||data[5]!==42)return invalidImage();
  const partitionSize=(data[0]+(data[1]<<8)+(data[2]<<16))>>>5;
  if(!partitionSize||partitionSize>data.length-10)return invalidImage();
  const width=d.getUint16(6,true)&16383,height=d.getUint16(8,true)&16383;
  if(!width||!height)return invalidImage();return {width,height};
 }
 if(kind==='VP8L'){
  if(data.length<=5||data[0]!==47)return invalidImage();
  const bits=d.getUint32(1,true);if(bits>>>29)return invalidImage();
  return {width:(bits&16383)+1,height:((bits>>>14)&16383)+1};
 }
 return invalidImage();
}
function webpDimensions(data:Uint8Array):Dimensions {
 if(data.length<20||fourCC(data,0)!=='RIFF'||fourCC(data,8)!=='WEBP')return invalidImage();
 const d=new DataView(data.buffer,data.byteOffset,data.byteLength);
 if(d.getUint32(4,true)+8!==data.length)return invalidImage();
 const u24=(p:number)=>data[p]+(data[p+1]<<8)+(data[p+2]<<16);
 let p=12,canvas:Dimensions|null=null,still:Dimensions|null=null,frames=0,orientation=1;
 while(p<data.length){
  if(p+8>data.length)return invalidImage();
  const kind=fourCC(data,p),length=d.getUint32(p+4,true),payload=p+8,end=payload+length,padded=end+(length&1);
  if(padded>data.length)return invalidImage();
  if(kind==='VP8X'){
   if(p!==12||length!==10||canvas)return invalidImage();
   canvas={width:u24(payload+4)+1,height:u24(payload+7)+1};
  }else if(kind==='VP8 '||kind==='VP8L'){
   if(still||frames)return invalidImage();still=webpBitstream(data.subarray(payload,end),kind);
  }else if(kind==='ANMF'){
   if(!canvas||still||length<24)return invalidImage();
   const x=u24(payload)*2,y=u24(payload+3)*2,w=u24(payload+6)+1,h=u24(payload+9)+1;
   if(x+w>canvas.width||y+h>canvas.height)return invalidImage();
   let sub=payload+16,frame:Dimensions|null=null;
   while(sub<end){
    if(sub+8>end)return invalidImage();
    const subKind=fourCC(data,sub),subLength=d.getUint32(sub+4,true),subEnd=sub+8+subLength;
    if(subEnd+(subLength&1)>end)return invalidImage();
    if(subKind==='VP8 '||subKind==='VP8L'){
     if(frame)return invalidImage();frame=webpBitstream(data.subarray(sub+8,subEnd),subKind);
    }
    sub=subEnd+(subLength&1);
   }
   if(!frame||frame.width!==w||frame.height!==h)return invalidImage();frames++;
  }else if(kind==='EXIF')orientation=exifOrientation(data.subarray(payload,end));
  p=padded;
 }
 if(!still&&!frames)return invalidImage();
 if(canvas&&still&&(canvas.width!==still.width||canvas.height!==still.height))return invalidImage();
 return orient(canvas??still!,orientation);
}

/**
 * Bounded container validation and display dimensions, not an image decoder.
 * Checks chunk/segment boundaries and an image payload; it does not decompress
 * pixels or verify PNG CRC/entropy codes. Upload UI must decode before submit.
 */
export function imageDimensions(data:Uint8Array,mime:string):Dimensions {
 const size=mime==='image/png'?pngDimensions(data):mime==='image/jpeg'?jpegDimensions(data):mime==='image/webp'?webpDimensions(data):invalidImage();
 if(!size.width||!size.height||size.width>12000||size.height>12000||size.width*size.height>24000000)throw new InputError('图片格式不正确，或尺寸超过2400万像素');
 return size;
}
