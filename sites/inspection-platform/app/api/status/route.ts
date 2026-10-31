import { getChatGPTUser } from '../../chatgpt-auth';
import { runtime } from '../../lib/server';
export async function GET(request:Request){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'请先登录'},{status:401});
 const e=runtime();const local=['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname);return Response.json({cloudReady:!!(e.DB&&e.BUCKET),aiConfigured:!!e.DASHSCOPE_API_KEY?.trim(),aiModel:e.AI_MODEL?.trim()||'qwen3-vl-plus',connection:'not-connected',storage:local?'local':'cloud'},{headers:{'Cache-Control':'no-store'}});
}
