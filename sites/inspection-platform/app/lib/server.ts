import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../chatgpt-auth';
import { InputError } from './validation';
import type { InspectionRecord } from './types';
export type Row={id:string;owner_id:string;created_at:string;updated_at:string;image_key:string;mime:string;revision:number;payload:string};
export const runtime=()=>env as unknown as Cloudflare.Env;
export async function access(request?:Request){
 const user=await getChatGPTUser();if(!user)throw new InputError('请先登录再操作',401);
 if(request&&request.method!=='GET'){
   const origin=request.headers.get('origin');if(!origin||origin!==new URL(request.url).origin)throw new InputError('请求来源不正确，请从工作台操作',403);
 }
 const {DB,BUCKET}=runtime();if(!DB||!BUCKET)throw new InputError('云端存储尚未就绪，请稍后重试',503);
 return {user,db:DB,bucket:BUCKET};
}
export async function getRow(db:D1Database,ownerId:string,id:string){
 if(!/^[0-9a-f-]{36}$/.test(id))throw new InputError('记录不存在',404);
 const row=await db.prepare('SELECT * FROM inspections WHERE id=? AND owner_id=?').bind(id,ownerId).first<Row>();
 if(!row)throw new InputError('记录不存在',404);return row;
}
export function recordFromRow(row:Row):InspectionRecord {
 const record:InspectionRecord={...JSON.parse(row.payload),id:row.id,createdAt:row.created_at,revision:row.revision,imageUrl:`/api/records/${row.id}/image`};
 if(record.source==='fpga'&&record.sourceCaptureId){
  record.resultImageUrl=`/api/records/${row.id}/image?view=result`;
  if(record.captureMetadata?.captureKind==='paired-display')delete record.edgeImageUrl;
  else record.edgeImageUrl=`/api/records/${row.id}/image?view=edges`;
 }
 return record;
}
export function failure(error:unknown){
 if(error instanceof InputError)return Response.json({error:error.message},{status:error.status});
 console.error('Inspection request failed', error instanceof Error?error.name:'UnknownError');
 return Response.json({error:'操作未完成，请稍后重试；已有记录不会因此被覆盖。'},{status:500});
}
export async function boundedBody(request:Request,limit:number):Promise<Uint8Array>{
 if(Number(request.headers.get('content-length')||0)>limit)throw new InputError('提交内容过大',413);
 if(!request.body)return new Uint8Array();
 const reader=request.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new InputError('提交内容过大',413);}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export async function jsonBody(request:Request){
 const text=new TextDecoder().decode(await boundedBody(request,150000));
 let data;try{data=JSON.parse(text);}catch{throw new InputError('提交数据不是有效JSON');}
 if(!data||typeof data!=='object'||Array.isArray(data))throw new InputError('提交数据必须是JSON对象');return data;
}
export async function imageForm(request:Request){
 const type=request.headers.get('content-type')||'';
 if(!type.startsWith('multipart/form-data;'))throw new InputError('请选择图片后上传');
 const bytes=await boundedBody(request,16*1024*1024);
 try{return await new Request(request.url,{method:'POST',headers:{'Content-Type':type},body:bytes.buffer as ArrayBuffer}).formData();}
 catch{throw new InputError('上传内容格式不正确');}
}
