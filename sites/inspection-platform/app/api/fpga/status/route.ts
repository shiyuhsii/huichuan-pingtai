import { failure, jsonBody } from '../../../lib/server';
import { fpgaAccess } from '../../../lib/fpga-server';
import { readFpgaStatus, writeFpgaStatus } from '../../../lib/fpga-storage';
import { validateFpgaStatus } from '../../../lib/fpga-validation';

export async function GET(request:Request){try{
 const {user,db}=await fpgaAccess(request);
 return Response.json({status:await readFpgaStatus(db,user.userId)},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return failure(error);}}
export async function POST(request:Request){try{
 const {user,db}=await fpgaAccess(request);const body=await jsonBody(request);
 return Response.json({status:await writeFpgaStatus(db,user.userId,validateFpgaStatus(body))},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return failure(error);}}
