import test from 'node:test';
import assert from 'node:assert/strict';
import {cf,productionDeployments} from '../../scripts/cicd/pages.mjs';

const deployment=n=>({id:`11111111-1111-1111-1111-${String(n).padStart(12,'0')}`,environment:'production',latest_stage:{status:'success'}});
async function withCloudflare(respond,check){
 const originalFetch=globalThis.fetch,originalLog=console.log,originalError=console.error;
 const vars={CLOUDFLARE_ACCOUNT_ID:'0'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic/token+only',PAGES_PROJECT:'fanscope'};
 const previous=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]])),requests=[],logs=[];
 try{
  Object.assign(process.env,vars);console.log=console.error=(...args)=>logs.push(args.join(' '));
  globalThis.fetch=async(url,options)=>{
   const u=new URL(url);requests.push({u,options});
   assert.equal(u.origin,'https://api.cloudflare.com');assert.equal(options.redirect,'error');
   assert.equal(options.headers.Authorization,`Bearer ${vars.CLOUDFLARE_API_TOKEN}`);
   return respond(u,options);
  };
  await check({requests,logs,vars});
 }finally{
  globalThis.fetch=originalFetch;console.log=originalLog;console.error=originalError;
  for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
}

test('Pages deployment list uses production env, 25 per page and envelope pagination',async()=>{
 await withCloudflare(u=>{
  assert.equal(u.searchParams.get('env'),'production');
  assert.equal(u.searchParams.get('per_page'),'25');
  const page=Number(u.searchParams.get('page'));
  assert.equal(u.pathname,`/client/v4/accounts/${'0'.repeat(32)}/pages/projects/fanscope/deployments`);
  return Response.json({success:true,result:page===1?Array.from({length:25},(_,i)=>deployment(i)): [deployment(25)],
   result_info:{page,per_page:25,total_pages:2,total_count:9999}});
 },async({requests})=>{
  const rows=await productionDeployments();assert.equal(rows.length,26);
  assert.equal(rows[25].id,deployment(25).id);assert.equal(requests.length,2);
  assert.ok(requests.every(r=>r.options.method==='GET'));
 });
});

test('Pages pagination supports missing optional metadata and server-selected page sizes',async()=>{
 for(const metadata of [false,true])await withCloudflare(u=>{
  const page=Number(u.searchParams.get('page')),size=metadata?2:25;
  return Response.json({success:true,result:page===1?Array.from({length:size},(_,i)=>deployment(i)):[],
   ...(metadata?{result_info:{page,per_page:size}}:{})});
 },async({requests})=>{assert.equal((await productionDeployments()).length,metadata?2:25);assert.equal(requests.length,2);});
});

test('Pages list rejects malformed, incomplete, repeated and non-production results',async()=>{
 const invalid=[
  {result:{}},{result:[null]},{result:[{...deployment(0),environment:'preview'}]},
  {result:[deployment(0),deployment(0)]},{result:[],result_info:{page:2}},
  {result:[],result_info:{per_page:100}},{result:[],result_info:{total_pages:'2'}},
  {result:[],result_info:{total_pages:2}},{result:[],result_info:'invalid'}
 ];
 for(const body of invalid)await withCloudflare(()=>Response.json({success:true,...body}),async()=>{
  await assert.rejects(productionDeployments(),/Invalid|Incomplete/);
 });
 await withCloudflare(()=>Response.json({success:true,result:[deployment(0)],result_info:{per_page:1}}),async()=>{
  await assert.rejects(productionDeployments(),/repeated/);
 });
 await withCloudflare(u=>Response.json({success:true,result:[deployment(Number(u.searchParams.get('page')))],result_info:{per_page:1}}),async({requests})=>{
  await assert.rejects(productionDeployments(),/limit exceeded/);assert.equal(requests.length,100);
 });
});

test('Cloudflare HTTP 400 diagnostic identifies endpoint, status and code without credentials',async()=>{
 await withCloudflare(()=>Response.json({success:false,errors:[{code:8000000,
  message:`Invalid per_page; token=${process.env.CLOUDFLARE_API_TOKEN}; account ${process.env.CLOUDFLARE_ACCOUNT_ID}\nAuthorization: Bearer private-header-value`}],
  result:{env_vars:{SECRET:'never-log-result'}}},{status:400}),async({logs,vars})=>{
  await assert.rejects(cf('/deployments?env=production&per_page=100'),e=>{
   assert.match(e.message,/GET \/accounts\/<account_id>\/pages\/projects\/fanscope\/deployments\?env=production&per_page=100: HTTP 400/);
   assert.match(e.message,/8000000/);assert.match(e.message,/Invalid per_page/);return true;
  });
  const output=logs.join('\n');assert.match(output,/"status":400/);assert.match(output,/"code":8000000/);
  for(const secret of [vars.CLOUDFLARE_API_TOKEN,vars.CLOUDFLARE_ACCOUNT_ID,'private-header-value','never-log-result'])assert.ok(!output.includes(secret));
 });
});

test('Cloudflare rejects API failures on HTTP 200, missing results and non-JSON errors safely',async()=>{
 for(const status of [200,401,403])await withCloudflare(()=>Response.json({success:false,errors:[{code:10000,message:'Authentication error'}]},{status}),async()=>{
  await assert.rejects(cf(''),new RegExp(`HTTP ${status}.*10000`));
 });
 for(const body of [{success:true},{success:true,result:null},{success:'true',result:[]},null])
  await withCloudflare(()=>Response.json(body),async()=>{await assert.rejects(cf(''),/HTTP 200/);});
 for(const status of [200,400,502])await withCloudflare(()=>new Response('<html>private-response-body</html>',{status}),async({logs})=>{
  await assert.rejects(cf(''),new RegExp(`HTTP ${status}.*Non-JSON`));assert.ok(!logs.join('').includes('private-response-body'));
 });
 await withCloudflare(()=>{throw Error('private-network-details');},async({logs})=>{
  await assert.rejects(cf(''),/Network request failed or timed out/);assert.ok(!logs.join('').includes('private-network-details'));
 });
});

test('Cloudflare logs sanitize encoded credentials, URLs, email and control characters',async()=>{
 await withCloudflare(()=>Response.json({success:false,errors:[{code:1,message:[
  encodeURIComponent(process.env.CLOUDFLARE_API_TOKEN),Buffer.from(process.env.CLOUDFLARE_API_TOKEN).toString('base64'),
  'https://private.invalid/?secret=hidden','person@example.invalid','\u001b[31mbad\nmessage'
 ].join(' ')}]},{status:400}),async({logs,vars})=>{
  await assert.rejects(cf(''),/HTTP 400/);const output=logs.join('');
  for(const secret of [encodeURIComponent(vars.CLOUDFLARE_API_TOKEN),Buffer.from(vars.CLOUDFLARE_API_TOKEN).toString('base64'),'private.invalid','person@example.invalid','\u001b'])assert.ok(!output.includes(secret));
 });
});
