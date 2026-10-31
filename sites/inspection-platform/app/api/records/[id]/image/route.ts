import { access,getRow,recordFromRow,failure } from '../../../../lib/server';
import { InputError } from '../../../../lib/validation';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){try{
 const {user,db,bucket}=await access();const {id}=await context.params;const row=await getRow(db,user.userId,id);
 const view=new URL(request.url).searchParams.get('view')||'default';
 if(!['default','original','result','edges'].includes(view))throw new InputError('图片视图不正确');
 const record=recordFromRow(row);
 if(view!=='default'&&view!=='original'&&(record.source!=='fpga'||!record.sourceCaptureId))throw new InputError('该记录没有设备结果图',404);
 if(record.captureMetadata?.captureKind==='paired-display'&&(view==='original'||view==='edges'))throw new InputError('该设备版本只回传拼接检测截图，没有独立原图或边缘图',404);
 const image=await bucket.get(view==='default'||view==='original'?row.image_key:`inspections/${row.id}/${view}`);
 if(!image)return Response.json({error:'图片暂时不可用'},{status:404});
 return new Response(image.body,{headers:{'Content-Type':view==='default'||view==='original'?row.mime:'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}});
 }catch(e){return failure(e);}}
