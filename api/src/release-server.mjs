// Reviewed HTTP-only maintenance entry. Never recover or start any background job.
import {config} from './config.mjs';
if(process.env.NODE_ENV!=='production'||process.env.FANSCOPE_RELEASE_HTTP_ONLY!=='true')throw Error('Explicit production HTTP-only mode required');
if(config.adminKey.length<24)throw Error('ADMIN_KEY missing');
if(config.dsKey||config.resendKey||process.env.OPENALEX_API_KEY)throw Error('Release acceptance requires empty paid/outbound keys');
globalThis.fetch=async()=>{throw Error('Outbound requests disabled during release acceptance');};
const {makeServer}=await import('./server.mjs');
const {db}=await import('./db.mjs');
const server=makeServer({readOnly:true});
server.listen(config.port,'0.0.0.0',()=>console.log(JSON.stringify({mode:'release-http-only',port:server.address().port,workers:false})));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>{db.close();process.exit(0);}));
