import type { FpgaCaptureMetadata, FpgaStatus, InspectionRecord, QualityMetrics } from './types';
import { captureIdentity, effectiveFpgaStatus, sha256Hex } from './fpga-validation';
import { InputError } from './validation';

export type CaptureImages = {result:Uint8Array;original?:Uint8Array;edges?:Uint8Array};
type CaptureRow = {record_id:string;fingerprint:string};
type StoredRow = {id:string;created_at:string;revision:number;payload:string};

export async function ensureCaptureTable(db:D1Database):Promise<void> {
 await db.prepare('CREATE TABLE IF NOT EXISTS fpga_captures (owner_id TEXT NOT NULL,capture_id TEXT NOT NULL,record_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner_id,capture_id))').run();
}
export async function ensureStatusTable(db:D1Database):Promise<void> {
 await db.prepare('CREATE TABLE IF NOT EXISTS fpga_receiver_status (owner_id TEXT PRIMARY KEY NOT NULL,updated_at TEXT NOT NULL,payload TEXT NOT NULL)').run();
}
async function captureRow(db:D1Database,ownerId:string,captureId:string):Promise<CaptureRow|null> {
 return db.prepare('SELECT record_id,fingerprint FROM fpga_captures WHERE owner_id=? AND capture_id=?').bind(ownerId,captureId).first<CaptureRow>();
}
async function existingRecord(db:D1Database,ownerId:string,capture:CaptureRow,fingerprint:string):Promise<InspectionRecord> {
 if(capture.fingerprint!==fingerprint)throw new InputError('同一设备、会话和帧的内容发生变化，已阻止覆盖原记录',409);
 const row=await db.prepare('SELECT id,created_at,revision,payload FROM inspections WHERE id=? AND owner_id=?').bind(capture.record_id,ownerId).first<StoredRow>();
 // Keep the identity tombstone on manual deletion. Queue retries must not
 // recreate a record which the operator deliberately removed.
 if(!row)throw new InputError('这一采集帧已被删除，不会自动重新导入',410);
 const record:InspectionRecord={...JSON.parse(row.payload),id:row.id,createdAt:row.created_at,revision:row.revision,imageUrl:`/api/records/${row.id}/image`,resultImageUrl:`/api/records/${row.id}/image?view=result`};
 if(record.captureMetadata?.captureKind==='paired-display')delete record.edgeImageUrl;
 else record.edgeImageUrl=`/api/records/${row.id}/image?view=edges`;
 return record;
}
async function cleanup(bucket:R2Bucket,keys:string[]):Promise<void> {
 try{await bucket.delete(keys);}catch{console.error('FPGA temporary image cleanup needed');}
}

/** Immutable PNGs are staged under a fresh record UUID. The inspection and
 * identity index commit in one D1 batch; concurrent retries never share R2 keys.
 * A retry reads the current record, retaining subsequent human review edits. */
export async function importFpgaCapture(db:D1Database,bucket:R2Bucket,ownerId:string,metadata:FpgaCaptureMetadata,images:CaptureImages,quality:QualityMetrics):Promise<{record:InspectionRecord;duplicate:boolean}> {
 await ensureCaptureTable(db);
 const encoder=new TextEncoder();
 const sourceCaptureId=await sha256Hex(encoder.encode(captureIdentity(metadata)));
 const fingerprint=await sha256Hex(encoder.encode(JSON.stringify(metadata)));
 const prior=await captureRow(db,ownerId,sourceCaptureId);
 if(prior)return {record:await existingRecord(db,ownerId,prior,fingerprint),duplicate:true};
 const paired=metadata.captureKind==='paired-display';
 const imageNames=paired?['result'] as const:['original','result','edges'] as const;
 const id=crypto.randomUUID(),createdAt=new Date().toISOString(),key=`inspections/${id}/${paired?'result':'original'}`;
 const record:InspectionRecord={id,createdAt,partId:metadata.partId||`帧-${metadata.frameId}`.slice(0,100),batchId:metadata.batchId||`${metadata.capturedAt.slice(0,10)}_${metadata.deviceId}`,filename:`${metadata.deviceId}_${metadata.frameId}_${paired?'detection':'original'}.png`,width:metadata.width,height:metadata.height,imageRole:paired?'paired-display':'original',imageUrl:`/api/records/${id}/image`,resultImageUrl:`/api/records/${id}/image?view=result`,...(!paired?{edgeImageUrl:`/api/records/${id}/image?view=edges`}:{}),sourceCaptureId,captureMetadata:metadata,boxes:metadata.boxes.map(({id,x,y,w,h})=>({id,x,y,w,h,label:'pending',note:paired?'从设备检测截图红框提取，坐标精度为截图像素。':'',origin:'fpga'})),quality,review:{label:'pending',note:''},ai:null,source:'fpga',revision:1};
 const keys=imageNames.map(name=>`inspections/${id}/${name}`);let committing=false;
 try{
  for(const name of imageNames){
   const bytes=images[name],hash=metadata.sha256[name];
   if(!bytes||!hash)throw new InputError('缺少采集类型对应的图片或校验值');
   await bucket.put(`inspections/${id}/${name}`,bytes as Uint8Array<ArrayBuffer>,{httpMetadata:{contentType:'image/png'},customMetadata:{recordId:id,sourceCaptureId,view:name,sha256:hash}});
  }
  committing=true;
  const results=await db.batch([
   db.prepare('INSERT INTO inspections (id,owner_id,created_at,updated_at,image_key,mime,revision,payload) VALUES (?,?,?,?,?,?,?,?)').bind(id,ownerId,createdAt,createdAt,key,'image/png',1,JSON.stringify(record)),
   db.prepare('INSERT INTO fpga_captures (owner_id,capture_id,record_id,fingerprint,created_at) VALUES (?,?,?,?,?)').bind(ownerId,sourceCaptureId,id,fingerprint,createdAt),
  ]);
  if(results.some(result=>!result.success))throw new Error('Capture transaction failed');
 }catch(error){
  if(committing){
   let winner:CaptureRow|null;
   try{winner=await captureRow(db,ownerId,sourceCaptureId);}
   catch{console.error('FPGA commit uncertain; staged images retained for recovery');throw error;}
   // A lost commit response must not delete images of an already committed row.
   if(winner?.record_id===id)return {record:await existingRecord(db,ownerId,winner,fingerprint),duplicate:false};
   await cleanup(bucket,keys);
   if(winner)return {record:await existingRecord(db,ownerId,winner,fingerprint),duplicate:true};
  }else await cleanup(bucket,keys);
  throw error;
 }
 return {record,duplicate:false};
}

export async function readFpgaStatus(db:D1Database,ownerId:string):Promise<FpgaStatus> {
 await ensureStatusTable(db);
 const row=await db.prepare('SELECT updated_at,payload FROM fpga_receiver_status WHERE owner_id=?').bind(ownerId).first<{updated_at:string;payload:string}>();
 return effectiveFpgaStatus(row?{...JSON.parse(row.payload),updatedAt:row.updated_at}:null);
}
export async function writeFpgaStatus(db:D1Database,ownerId:string,status:Omit<FpgaStatus,'updatedAt'|'stale'>):Promise<FpgaStatus> {
 await ensureStatusTable(db);const updatedAt=new Date().toISOString();
 await db.prepare('INSERT INTO fpga_receiver_status (owner_id,updated_at,payload) VALUES (?,?,?) ON CONFLICT(owner_id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload').bind(ownerId,updatedAt,JSON.stringify(status)).run();
 return {...status,updatedAt,stale:false};
}
