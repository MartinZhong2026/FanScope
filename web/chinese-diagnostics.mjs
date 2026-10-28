// Optional, separately validated capability. An old/failed diagnostic endpoint
// must not turn a working English feed into a global backend error.
export async function readChineseDiagnostics(read){
 try{
  const data=await read('/api/chinese-diagnostics');
  if(data?.market!=='chinese'||!Array.isArray(data.items)||!data.window?.start||!data.window?.end)throw Error('Invalid diagnostics');
  const ids=new Set();for(const item of data.items){if(!item.id||ids.has(item.id)||item.market!=='chinese'||!Number.isInteger(item.total)||item.total<0)throw Error('Invalid journal diagnostics');ids.add(item.id);}
  return {...data,available:true};
 }catch{return {available:false};}
}
