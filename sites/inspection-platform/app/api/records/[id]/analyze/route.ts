import { access,getRow,recordFromRow,failure,runtime } from '../../../../lib/server';
import { InputError } from '../../../../lib/validation';
import { analyzeImage } from '../../../../lib/ai';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){try{
 const {user,db,bucket}=await access(request);const {id}=await context.params;const row=await getRow(db,user.userId,id);
 const e=runtime();if(!e.DASHSCOPE_API_KEY?.trim())throw new InputError('AI 尚未配置。请在云端设置北京地域的 DASHSCOPE_API_KEY；图片归档与人工复核可正常使用。',503);
 const image=await bucket.get(row.image_key);if(!image)throw new InputError('图片暂时不可用',404);
 const record=recordFromRow(row);record.ai=await analyzeImage(await image.arrayBuffer(),row.mime,record,e.DASHSCOPE_API_KEY,e.AI_MODEL);
 if(record.ai.status!=='done')return Response.json({error:record.ai.summary||'AI 分析未完成，请稍后重试'},{status:502});
 record.revision++;
 const result=await db.prepare('UPDATE inspections SET payload=?,revision=?,updated_at=? WHERE id=? AND owner_id=? AND revision=?').bind(JSON.stringify(record),record.revision,new Date().toISOString(),id,user.userId,row.revision).run();
 if(!result.meta.changes)throw new InputError('分析期间记录已更新，已保留你的最新复核；请刷新后重试分析',409);
 return Response.json({record});
 }catch(e){return failure(e);}}
