// Offline only: Node's in-memory SQLite and an in-memory R2 substitute.
// No service, serial port, local records, network or cloud API is used.
// node --experimental-transform-types --test tests/fpga.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';

const project=new URL('../',import.meta.url);
globalThis.__fpgaTestRuntime={};globalThis.__fpgaTestHeaders=new Headers();
registerHooks({resolve(specifier,context,nextResolve){
 if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export const env=globalThis.__fpgaTestRuntime;',shortCircuit:true};
 if(specifier==='next/headers')return {url:'data:text/javascript,export const headers=async()=>globalThis.__fpgaTestHeaders;',shortCircuit:true};
 if(specifier==='next/navigation')return {url:'data:text/javascript,export const redirect=()=>{throw new Error("Unexpected redirect");};',shortCircuit:true};
 if(specifier.startsWith('.')&&context.parentURL?.startsWith(project.href)&&!specifier.endsWith('.ts')&&!specifier.endsWith('.mjs')){
  const url=new URL(`${specifier}.ts`,context.parentURL);return {url:url.href,shortCircuit:true};
 }
 return nextResolve(specifier,context);
}});
// Never allow an overlooked test mock to reach a real service.
globalThis.fetch=async()=>{throw new Error('Real network access is disabled in fpga.test.mjs');};
const validation=await import('../app/lib/fpga-validation.ts');
const captures=await import('../app/api/fpga/captures/route.ts');
const statusApi=await import('../app/api/fpga/status/route.ts');
const recordApi=await import('../app/api/records/[id]/route.ts');
const imageApi=await import('../app/api/records/[id]/image/route.ts');
const base='http://127.0.0.1:5317';
const tiny=new Uint8Array(readFileSync(new URL('./fixtures/tiny.png',import.meta.url)));
const hash=await validation.sha256Hex(tiny);
const quality={brightness:120,darkRatio:.1,brightRatio:.1,sharpness:90,warnings:[],verdict:'good'};

class MemoryD1 {
 constructor(){
  this.sqlite=new DatabaseSync(':memory:');this.throwAfterCommit=false;
  this.sqlite.exec('CREATE TABLE inspections (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,image_key TEXT NOT NULL,mime TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL)');
 }
 prepare(sql){
  const connection=this;return {sql,args:[],bind(...args){return {...this,args};},
   async run(){const result=connection.sqlite.prepare(sql).run(...this.args);return {success:true,meta:{changes:Number(result.changes)}};},
   async first(){return connection.sqlite.prepare(sql).get(...this.args)??null;},
   async all(){return {success:true,results:connection.sqlite.prepare(sql).all(...this.args)};}};
 }
 async batch(statements){
  this.sqlite.exec('BEGIN');let results;
  try{results=statements.map(s=>{const result=this.sqlite.prepare(s.sql).run(...s.args);return {success:true,meta:{changes:Number(result.changes)}};});this.sqlite.exec('COMMIT');}
  catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  if(this.throwAfterCommit){this.throwAfterCommit=false;throw new Error('Simulated lost commit response');}return results;
 }
}
class MemoryR2 {
 images=new Map();puts=0;failOnPut=0;
 async put(key,bytes,metadata){this.puts++;if(this.puts===this.failOnPut)throw new Error('Simulated failed image write');this.images.set(key,{bytes:Uint8Array.from(bytes),metadata});}
 async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])this.images.delete(key);}
 async get(key){const item=this.images.get(key);return item?{body:item.bytes}:null;}
}
function environment(){const db=new MemoryD1(),bucket=new MemoryR2();Object.assign(globalThis.__fpgaTestRuntime,{DB:db,BUCKET:bucket});return {db,bucket};}
function metadata(extra={}){return {version:1,source:'fpga-cnn',deviceId:'VF-Ti60',sessionId:'test-session',frameId:'0001',capturedAt:'2026-10-30T08:30:00.000Z',width:3,height:2,build:'B3260012',boxes:[{id:'cnn-0',x:0,y:0,w:.5,h:.5,score:.9}],sha256:{original:hash,result:hash,edges:hash},...extra};}
function paired(extra={}){return metadata({captureKind:'paired-display',sourceProtocol:'VFAUTO1',originalAvailable:false,scratchCount:3,boxes:[],sha256:{result:hash},...extra});}
function authorize(request,user='owner-1'){
 globalThis.__fpgaTestHeaders=new Headers(request.headers);
 if(user){globalThis.__fpgaTestHeaders.set('oai-authenticated-user-id',user);globalThis.__fpgaTestHeaders.set('oai-authenticated-user-email',`${user}@local.test`);}
}
function upload(data=metadata(),options={}){
 const form=new FormData();form.set('metadata',JSON.stringify(data));
 const names=data.captureKind==='paired-display'?['result']:['original','result','edges'];
 for(const name of names)if(name!==options.omit)form.set(name,new File([options.bytes??tiny],`${name}.png`,{type:options.mime??'image/png'}));
 if(options.quality)form.set('quality',JSON.stringify(options.quality));
 if(options.extraFile)form.set('original',new File([tiny],'not-original.png',{type:'image/png'}));
 const request=new Request(`${base}/api/fpga/captures`,{method:'POST',headers:{Origin:options.origin??base},body:form});authorize(request,options.user===undefined?'owner-1':options.user);return captures.POST(request);
}
async function image(id,view='',user='owner-1'){
 const request=new Request(`${base}/api/records/${id}/image${view?`?view=${view}`:''}`);authorize(request,user);
 return imageApi.GET(request,{params:Promise.resolve({id})});
}
async function jsonRequest(api,data,{method='POST',url=`${base}/api/fpga/status`,user='owner-1',origin=base,id}={}){
 const request=new Request(url,{method,headers:{Origin:origin,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});authorize(request,user);
 return api(request,{params:Promise.resolve({id})});
}

test('PNG checks CRC, dimensions, supported color format and actual deflate scanlines',async()=>{
 await validation.validateCapturePng(tiny,3,2);
 const damaged=tiny.slice();damaged[damaged.length-1]^=1;
 await assert.rejects(()=>validation.validateCapturePng(damaged,3,2));
 await assert.rejects(()=>validation.validateCapturePng(tiny,2,3));
 await assert.rejects(()=>validation.validateCapturePng(tiny.subarray(0,33),3,2));
 function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
 function chunk(kind,bytes){const payload=Buffer.concat([Buffer.from(kind),Buffer.from(bytes)]),out=Buffer.alloc(payload.length+8);out.writeUInt32BE(bytes.length);payload.copy(out,4);out.writeUInt32BE(crc(payload),out.length-4);return out;}
 function png(raw,color=2){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(3);ihdr.writeUInt32BE(2,4);ihdr[8]=8;ihdr[9]=color;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',[]) ]);}
 await validation.validateCapturePng(png(new Uint8Array(20)),3,2);
 await assert.rejects(()=>validation.validateCapturePng(png(new Uint8Array(21)),3,2));
 const badFilter=new Uint8Array(20);badFilter[10]=5;
 await assert.rejects(()=>validation.validateCapturePng(png(badFilter),3,2));
 await assert.rejects(()=>validation.validateCapturePng(png(new Uint8Array(20),3),3,2));
});

test('metadata rejects false original claims, forged boxes, paths, hashes and invalid coordinates',()=>{
 assert.equal(validation.validateCaptureMetadata(metadata()).captureKind,'separate-images');
 assert.equal(validation.validateCaptureMetadata(paired()).originalAvailable,false);
 for(const invalid of [metadata({width:0}),metadata({sha256:{result:hash}}),metadata({boxes:[{id:'bad',x:.9,y:0,w:.2,h:.2}]}),metadata({originalPath:'C:\\secret.png'}),paired({originalAvailable:true}),paired({boxes:metadata().boxes}),paired({scratchCount:33}),paired({sha256:{original:hash,result:hash}})])assert.throws(()=>validation.validateCaptureMetadata(invalid));
});

test('local-only access retains authentication, owner checks and same-origin writes',async()=>{
 environment();
 assert.equal((await upload(metadata(),{user:null})).status,401);
 assert.equal((await upload(metadata(),{origin:'https://other.invalid'})).status,403);
 const request=new Request('https://public.example/api/fpga/status');authorize(request);
 assert.equal((await statusApi.GET(request)).status,403);
 const response=await upload();assert.equal(response.status,201);const {record}=await response.json();
 assert.equal((await image(record.id,'','other-owner')).status,404);
 assert.equal((await image(record.id,'','')).status,401);
});

test('three-image capture persists all variants with pending review and exact PNG bytes',async()=>{
 const {bucket}=environment();const response=await upload(metadata(),{quality});assert.equal(response.status,201,await response.clone().text());
 const {record,duplicate}=await response.json();assert.equal(duplicate,false);assert.equal(record.source,'fpga');assert.equal(record.imageRole,'original');assert.equal(record.boxes[0].label,'pending');assert.equal(record.review.label,'pending');assert.equal(record.quality.measured,true);assert.equal(bucket.images.size,3);
 for(const view of ['', 'original','result','edges']){const response=await image(record.id,view);assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),tiny);}
 assert.equal((await image(record.id,'../../secret')).status,400);
});

test('real VFAUTO1 screenshot stores one image and never exposes it as a separate original or edge',async()=>{
 const {bucket}=environment();const response=await upload(paired());assert.equal(response.status,201,await response.clone().text());
 const {record}=await response.json();assert.equal(record.imageRole,'paired-display');assert.equal(record.captureMetadata.sourceProtocol,'VFAUTO1');assert.equal(record.captureMetadata.originalAvailable,false);assert.equal(record.captureMetadata.scratchCount,3);assert.deepEqual(record.boxes,[]);assert.equal(record.edgeImageUrl,undefined);assert.equal(record.quality.measured,false);assert.equal(bucket.images.size,1);
 assert.equal((await image(record.id)).status,200);assert.equal((await image(record.id,'result')).status,200);assert.equal((await image(record.id,'original')).status,404);assert.equal((await image(record.id,'edges')).status,404);
 assert.equal((await upload(paired({frameId:'0002'}),{extraFile:true})).status,400);
});

test('paired screenshot overlay boxes require provenance and preserve review through retries',async()=>{
 const box={id:'display-0',x:.1,y:.2,w:.2,h:.3};
 const data=paired({boxesSource:'display-overlay',boxes:[box]});
 const parsed=validation.validateCaptureMetadata(data);
 assert.equal(parsed.boxesSource,'display-overlay');assert.deepEqual(parsed.boxes,[box]);
 for(const invalid of [paired({boxes:[box]}),paired({boxesSource:'device',boxes:[box]}),metadata({boxesSource:'display-overlay'}),paired({boxesSource:'display-overlay',boxes:[{...box,x:.6}]}),paired({boxesSource:'display-overlay',boxes:[{...box,score:.9}]}),paired({boxesSource:'display-overlay',scratchCount:1,boxes:[box,{...box,id:'display-1'}]})])assert.throws(()=>validation.validateCaptureMetadata(invalid));
 const {bucket,db}=environment();const response=await upload(data);assert.equal(response.status,201,await response.clone().text());
 const {record}=await response.json();assert.equal(record.boxes[0].origin,'fpga');assert.match(record.boxes[0].note,/截图红框提取/);assert.equal(record.boxes[0].label,'pending');
 const reviewed={...record.boxes[0],label:'scratch',removed:true};
 const patch=await jsonRequest(recordApi.PATCH,{revision:1,boxes:[reviewed]},{method:'PATCH',url:`${base}/api/records/${record.id}`,id:record.id});assert.equal(patch.status,200);assert.deepEqual((await patch.json()).record.boxes,[reviewed]);
 const stored=JSON.parse(db.sqlite.prepare('SELECT payload FROM inspections WHERE id=?').get(record.id).payload);assert.deepEqual(stored.boxes,[reviewed]);
 const duplicate=await (await upload(data)).json();assert.equal(duplicate.duplicate,true);assert.equal(duplicate.record.revision,2);assert.deepEqual(duplicate.record.boxes,[reviewed]);assert.equal(duplicate.record.captureMetadata.scratchCount,3);
 assert.equal(bucket.puts,1);assert.deepEqual(new Uint8Array(await (await image(record.id,'result')).arrayBuffer()),tiny);
 const restored=await jsonRequest(recordApi.PATCH,{revision:2,boxes:[{...reviewed,removed:false}]},{method:'PATCH',url:`${base}/api/records/${record.id}`,id:record.id});assert.equal(restored.status,200);assert.equal((await restored.json()).record.boxes[0].removed,false);
 const invalid=await jsonRequest(recordApi.PATCH,{revision:3,boxes:[{...reviewed,removed:'true'}]},{method:'PATCH',url:`${base}/api/records/${record.id}`,id:record.id});assert.equal(invalid.status,400);
});

test('invalid and incomplete uploads do not create images or records',async()=>{
 const {bucket,db}=environment();
 assert.equal((await upload(metadata({sha256:{original:'0'.repeat(64),result:hash,edges:hash}}))).status,422);
 assert.equal((await upload(metadata(),{omit:'edges'})).status,400);
 assert.equal((await upload(metadata(),{mime:'image/jpeg'})).status,400);
 assert.equal(bucket.images.size,0);assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM inspections').get().count,0);
});

test('idempotent retries retain manual review and reject same-frame changes',async()=>{
 const {db,bucket}=environment();const {record}=await (await upload()).json();
 const patch=await jsonRequest(recordApi.PATCH,{revision:1,review:{label:'normal-hole',note:'人工复核结果'},boxes:[]},{method:'PATCH',url:`${base}/api/records/${record.id}`,id:record.id});assert.equal(patch.status,200);
 const retried=await upload();assert.equal(retried.status,200);const duplicate=await retried.json();assert.equal(duplicate.duplicate,true);assert.equal(duplicate.record.id,record.id);assert.equal(duplicate.record.revision,2);assert.equal(duplicate.record.review.label,'normal-hole');assert.deepEqual(duplicate.record.boxes,[]);assert.equal(bucket.images.size,3);
 const conflict=await upload(metadata({boxes:[]}));assert.equal(conflict.status,409);assert.equal(bucket.images.size,3);assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM inspections').get().count,1);
});

test('concurrent duplicate import commits one row and removes only losing staged images',async()=>{
 const {db,bucket}=environment();const results=await Promise.all([upload(),upload()]);assert.deepEqual(results.map(x=>x.status).sort(),[200,201]);
 const records=await Promise.all(results.map(x=>x.json()));assert.equal(records[0].record.id,records[1].record.id);assert.equal(bucket.images.size,3);assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM inspections').get().count,1);
});

test('partial R2 failure leaves no visible record and cleans staged images',async()=>{
 const {db,bucket}=environment();bucket.failOnPut=2;assert.equal((await upload()).status,500);assert.equal(bucket.images.size,0);assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM inspections').get().count,0);
});

test('a lost transaction response preserves already committed images',async()=>{
 const {db,bucket}=environment();db.throwAfterCommit=true;const response=await upload();assert.equal(response.status,201,await response.clone().text());assert.equal(bucket.images.size,3);assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM inspections').get().count,1);
});

test('delete removes every stored variant and tombstone blocks queue resurrection',async()=>{
 for(const data of [metadata(),paired()]){
  const {db,bucket}=environment();const {record}=await (await upload(data)).json();
  const deleted=await jsonRequest(recordApi.DELETE,undefined,{method:'DELETE',url:`${base}/api/records/${record.id}?revision=1`,id:record.id});assert.equal(deleted.status,200);assert.equal(bucket.images.size,0);assert.equal((await image(record.id)).status,404);
  assert.equal((await upload(data)).status,410);assert.equal(bucket.images.size,0);assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM inspections').get().count,0);
 }
});

test('status requires actual handshake and turns disconnected after 15 seconds without heartbeat',async()=>{
 const {db}=environment();const request=new Request(`${base}/api/fpga/status`);authorize(request);const initial=await (await statusApi.GET(request)).json();assert.equal(initial.status.updatedAt,null);assert.equal(initial.status.stale,true);
 assert.equal((await jsonRequest(statusApi.POST,{connection:'connected',handshake:false,sync:'idle'})).status,400);
 const updated=await jsonRequest(statusApi.POST,{connection:'receiving',handshake:true,port:'COM9',build:'B3260012',progress:50,sync:'pending',archivePath:'C:\\Users\\local\\Desktop\\CNN检测归档'});assert.equal(updated.status,200);const fresh=(await updated.json()).status;assert.equal(fresh.stale,false);assert.equal(fresh.handshake,true);
 const stale=validation.effectiveFpgaStatus(fresh,Date.parse(fresh.updatedAt)+15001);assert.equal(stale.connection,'disconnected');assert.equal(stale.handshake,false);assert.equal(stale.stale,true);
 db.sqlite.prepare('UPDATE fpga_receiver_status SET updated_at=?').run(new Date(Date.now()-16000).toISOString());authorize(request);const observed=(await (await statusApi.GET(request)).json()).status;assert.equal(observed.connection,'disconnected');assert.equal(observed.stale,true);
});
