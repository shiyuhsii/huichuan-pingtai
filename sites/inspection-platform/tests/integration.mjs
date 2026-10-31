// Explicit local preview smoke test. Creates then deletes one fixture record.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base=process.env.INSPECTION_TEST_URL||'http://127.0.0.1:5173';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw new Error('Integration test is local-only');
const login=await fetch(`${base}/signin-with-chatgpt?return_to=/`,{redirect:'manual'});
const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
assert.ok(cookie,'Local preview sign-in cookie missing');
const request=(path,opts={})=>fetch(base+path,{...opts,headers:{Cookie:cookie,Origin:base,...opts.headers}});
const j=body=>({headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const response=await request('/api/status');assert.equal(response.status,200);assert.equal((await response.json()).aiConfigured,false);
assert.equal((await fetch(base+'/api/records')).status,401);
assert.equal((await fetch(base+'/api/records',{method:'POST',headers:{Cookie:cookie}})).status,403);
let record;
try{
 const badForm=new FormData();badForm.set('file',new File([new Uint8Array([137,80,78,71,13,10,26,10])],'truncated.png',{type:'image/png'}));
 assert.equal((await request('/api/records',{method:'POST',body:badForm})).status,400);
 const form=new FormData();form.set('file',new File([await readFile(new URL('./fixtures/integration-generated.png',import.meta.url))],'integration-generated.png',{type:'image/png'}));
 form.set('partId','TEST-001');form.set('batchId','自动验证临时数据');
 form.set('quality',JSON.stringify({brightness:140,darkRatio:.1,brightRatio:.1,sharpness:120,warnings:[],verdict:'good'}));
 const uploaded=await request('/api/records',{method:'POST',body:form});assert.equal(uploaded.status,201,await uploaded.clone().text());record=(await uploaded.json()).record;
 assert.ok(record.width>100);const image=await request(record.imageUrl);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.match(image.headers.get('cache-control'),/no-store/);
 const path=`/api/records/${record.id}`;
 assert.equal((await request(path,{method:'PATCH',...j(null)})).status,400);
 assert.equal((await request(path,{method:'PATCH',...j({revision:record.revision,review:null})})).status,400);
 const patched=await request(path,{method:'PATCH',...j({revision:record.revision,review:{label:'scratch',note:'复核测试，结束后删除'},boxes:[{id:'test-box',x:.2,y:.3,w:.1,h:.1,label:'scratch',note:'局部',origin:'manual'}]})});
 assert.equal(patched.status,200,await patched.clone().text());const oldRevision=record.revision;record=(await patched.json()).record;
 assert.equal(record.review.label,'scratch');assert.equal(record.boxes.length,1);
 assert.equal((await request(path,{method:'PATCH',...j({revision:oldRevision,review:{label:'shadow',note:''}})})).status,409);
 assert.equal((await request(path+'/analyze',{method:'POST'})).status,503);
 const listed=(await (await request('/api/records')).json()).records.find(x=>x.id===record.id);assert.equal(listed.review.label,'scratch');
 assert.equal((await request(path+`?revision=${oldRevision}`,{method:'DELETE'})).status,409);
 assert.equal((await request(path+`?revision=${record.revision}`,{method:'DELETE'})).status,200);
 assert.equal((await request(record.imageUrl)).status,404);record=null;
 console.log('PASS: auth, origin, image upload/read, persistent review, malformed requests, version conflicts, AI-unconfigured, and delete cleanup.');
}finally{if(record)await request(`/api/records/${record.id}?revision=${record.revision}`,{method:'DELETE'});}
