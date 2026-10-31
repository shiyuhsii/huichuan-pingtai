import { access,getRow,recordFromRow,failure,jsonBody } from '../../../lib/server';
import { InputError,cleanText,reviewLabel,validateBoxes } from '../../../lib/validation';
type Context={params:Promise<{id:string}>};
export async function PATCH(request:Request,context:Context){try{
 const {user,db}=await access(request);const {id}=await context.params;const row=await getRow(db,user.userId,id);const body=await jsonBody(request);
 if(body.revision!==row.revision)throw new InputError('这条记录已在其他窗口更新，请刷新后重试',409);
 const record=recordFromRow(row);
 if(body.partId!==undefined)record.partId=cleanText(body.partId,'零件编号',100);
 if(body.batchId!==undefined)record.batchId=cleanText(body.batchId,'批次',100);
 if(body.boxes!==undefined)record.boxes=validateBoxes(body.boxes);
 if(body.review!==undefined){
  if(!body.review||typeof body.review!=='object'||Array.isArray(body.review))throw new InputError('复核信息格式不正确');
  record.review={label:reviewLabel(body.review.label),note:cleanText(body.review.note??'','复核备注',4000)};
 }
 record.revision++;
 const result=await db.prepare('UPDATE inspections SET payload=?,revision=?,updated_at=? WHERE id=? AND owner_id=? AND revision=?').bind(JSON.stringify(record),record.revision,new Date().toISOString(),id,user.userId,row.revision).run();
 if(!result.meta.changes)throw new InputError('记录发生更新，请刷新后重试',409);
 return Response.json({record});
 }catch(e){return failure(e);}}
export async function DELETE(request:Request,context:Context){try{
 const {user,db,bucket}=await access(request);const {id}=await context.params;const row=await getRow(db,user.userId,id);
 const revision=Number(new URL(request.url).searchParams.get('revision'));
 if(revision!==row.revision)throw new InputError('记录已更新，请刷新确认后再删除',409);
 const result=await db.prepare('DELETE FROM inspections WHERE id=? AND owner_id=? AND revision=?').bind(id,user.userId,revision).run();
 if(!result.meta.changes)throw new InputError('记录已更新，请刷新确认后再删除',409);
 const record=recordFromRow(row);const keys=record.source==='fpga'&&record.sourceCaptureId&&record.captureMetadata?.captureKind!=='paired-display'?[row.image_key,`inspections/${row.id}/result`,`inspections/${row.id}/edges`]:[row.image_key];
 try{await bucket.delete(keys);}catch{console.error('Orphan image cleanup needed',row.id);return Response.json({deleted:true,cleanupPending:true});}
 return Response.json({deleted:true});
 }catch(e){return failure(e);}}
