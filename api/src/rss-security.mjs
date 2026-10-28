// HTTPS only, exact operator-reviewed hosts, DNS pinning, no redirects/proxy/DTD.
import https from 'node:https';
import dns from 'node:dns/promises';
import {BlockList,isIP} from 'node:net';
const blocked=new BlockList();
for(const [a,n] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])blocked.addSubnet(a,n);
export function publicAddress(a){const kind=isIP(a);if(kind===4)return !blocked.check(a,'ipv4');if(kind===6){const b=new BlockList();b.addSubnet('2000::',3,'ipv6');const denied=new BlockList();denied.addSubnet('2001::',23,'ipv6');denied.addSubnet('2001:db8::',32,'ipv6');denied.addSubnet('2002::',16,'ipv6');denied.addSubnet('3fff::',20,'ipv6');return b.check(a,'ipv6')&&!denied.check(a,'ipv6')}return false}
export function approvedURL(value,hosts){if(typeof value!=='string'||value.length>2048)throw Error('Invalid RSS URL length');let u;try{u=new URL(value)}catch{throw Error('Invalid RSS URL')}
 if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||isIP(u.hostname)||!hosts.includes(u.hostname))throw Error('RSS URL host is not approved');return u;
}
export async function secureFeed(value,hosts,{resolve=dns.lookup,transport=https.request,timeoutMs=20000}={}){
 const started=Date.now(),u=approvedURL(value,hosts);let addresses,dnsTimer;
 try{addresses=await Promise.race([resolve(u.hostname,{all:true,verbatim:true}),new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(Error('RSS DNS timeout')),timeoutMs)})])}finally{clearTimeout(dnsTimer)}
 if(!addresses.length||addresses.some(x=>!publicAddress(x.address)))throw Error('RSS DNS resolved to a forbidden address');
 const address=addresses[0];
 return new Promise((ok,no)=>{const req=transport(u,{method:'GET',headers:{Accept:'application/rss+xml,application/atom+xml,application/xml,text/xml','User-Agent':'FanScope RSS/1.0'},lookup:(_host,opts,cb)=>cb(null,opts?.all?[address]:address.address,address.family)},res=>{
  if(res.statusCode!==200){res.resume();no(Error('RSS HTTP '+res.statusCode+' (redirects forbidden)'));return}
  let size=0;const chunks=[];res.on('data',c=>{size+=c.length;if(size>2e6){res.destroy(Error('RSS exceeds 2MB'));return}chunks.push(c)});res.on('error',no);res.on('end',()=>ok(Buffer.concat(chunks).toString('utf8')));
 });const timeout=setTimeout(()=>req.destroy(Error('RSS timeout')),Math.max(1,timeoutMs-(Date.now()-started)));req.on('close',()=>clearTimeout(timeout));req.on('error',no);req.end()});
}
