import { failure, imageForm } from '../../../lib/server';
import { fpgaAccess } from '../../../lib/fpga-server';
import { importFpgaCapture, type CaptureImages } from '../../../lib/fpga-storage';
import { sha256Hex, validateCaptureMetadata, validateCapturePng, FPGA_IMAGE_LIMIT } from '../../../lib/fpga-validation';
import { InputError, validateQuality } from '../../../lib/validation';
import type { QualityMetrics } from '../../../lib/types';

export async function POST(request:Request){try{
 const {user,db,bucket}=await fpgaAccess(request);
 const form=await imageForm(request);const allowed=new Set(['metadata','original','result','edges','quality']);
 for(const key of form.keys())if(!allowed.has(key)||form.getAll(key).length!==1)throw new InputError('采集上传字段重复或不受支持');
 const text=form.get('metadata');if(typeof text!=='string'||text.length>100000)throw new InputError('缺少采集元数据或内容过大');
 let parsed;try{parsed=JSON.parse(text);}catch{throw new InputError('采集元数据不是有效JSON');}
 const metadata=validateCaptureMetadata(parsed);const images={} as CaptureImages;
 const paired=metadata.captureKind==='paired-display';
 if(paired&&(form.has('original')||form.has('edges')))throw new InputError('拼接检测截图不能冒充独立原图或边缘图');
 const names=paired?['result'] as const:['original','result','edges'] as const;
 for(const name of names){
  const file=form.get(name);
  if(!(file instanceof File)||file.type!=='image/png'||!file.size||file.size>FPGA_IMAGE_LIMIT)throw new InputError('请上传采集类型对应的5MB以内PNG文件');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(await sha256Hex(bytes)!==metadata.sha256[name])throw new InputError(`${name}图片校验失败，请重新传输`,422);
  await validateCapturePng(bytes,metadata.width,metadata.height);images[name]=bytes;
 }
 let quality:QualityMetrics={brightness:0,darkRatio:0,brightRatio:0,sharpness:0,warnings:['尚未测量这张采集图的拍摄质量，请人工确认曝光、清晰度和反光。'],verdict:'review',measured:false};
 const qualityText=form.get('quality');
 if(qualityText!==null){
  if(typeof qualityText!=='string'||qualityText.length>10000)throw new InputError('拍摄质量数据格式不正确');
  let data;try{data=JSON.parse(qualityText);}catch{throw new InputError('拍摄质量数据不是有效JSON');}
  quality={...validateQuality(data),measured:true};
 }
 const result=await importFpgaCapture(db,bucket,user.userId,metadata,images,quality);
 return Response.json(result,{status:result.duplicate?200:201,headers:{'Cache-Control':'no-store'}});
 }catch(error){return failure(error);}}
