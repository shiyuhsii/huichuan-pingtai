import { access,recordFromRow,failure,imageForm,type Row } from '../../lib/server';
import { cleanText,validateBoxes,validateQuality,imageDimensions,InputError } from '../../lib/validation';
import type { InspectionRecord } from '../../lib/types';
export async function GET(){try{
 const {user,db}=await access();const {results}=await db.prepare('SELECT * FROM inspections WHERE owner_id=? ORDER BY created_at DESC LIMIT 1000').bind(user.userId).all<Row>();
 return Response.json({records:results.map(recordFromRow),limit:1000},{headers:{'Cache-Control':'no-store'}});
 }catch(e){return failure(e);}}
export async function POST(request:Request){try{
 const {user,db,bucket}=await access(request);
 if(Number(request.headers.get('content-length')||0)>16*1024*1024)throw new InputError('单张图片最大15MB',413);
 const form=await imageForm(request);const file=form.get('file');
 if(!(file instanceof File)||!file.size||file.size>15*1024*1024)throw new InputError('请选择15MB以内的图片');
 if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new InputError('支持JPG、PNG、WebP图片');
 const bytes=await file.arrayBuffer();const dimensions=imageDimensions(new Uint8Array(bytes),file.type);
 const partId=cleanText(form.get('partId')||'未编号','零件编号',100);const batchId=cleanText(form.get('batchId')||'未分批','批次',100);
 let quality,boxes;try{quality=validateQuality(JSON.parse(String(form.get('quality'))));boxes=validateBoxes(JSON.parse(String(form.get('boxes')||'[]')));}catch(e){if(e instanceof InputError)throw e;throw new InputError('图片检查数据格式不正确');}
 const id=crypto.randomUUID();const createdAt=new Date().toISOString();const key=`inspections/${id}/original`;
 const record:InspectionRecord={id,createdAt,partId,batchId,filename:cleanText(file.name,'文件名',240),...dimensions,imageUrl:`/api/records/${id}/image`,boxes,quality,review:{label:'pending',note:''},ai:null,source:'manual',revision:1};
 await bucket.put(key,bytes,{httpMetadata:{contentType:file.type},customMetadata:{recordId:id}});
 try{await db.prepare('INSERT INTO inspections (id,owner_id,created_at,updated_at,image_key,mime,revision,payload) VALUES (?,?,?,?,?,?,?,?)').bind(id,user.userId,createdAt,createdAt,key,file.type,1,JSON.stringify(record)).run();}
 catch(e){await bucket.delete(key);throw e;}
 return Response.json({record},{status:201});
 }catch(e){return failure(e);}}
