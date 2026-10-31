import { access } from './server';
import { InputError } from './validation';

/** Keep the bridge on this computer and preserve the existing sign-in and
 * same-origin checks. The launcher binds the server to loopback only. */
export async function fpgaAccess(request:Request) {
 const url=new URL(request.url);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new InputError('自动回传接口仅在本机工作台开放',403);
 return access(request);
}
