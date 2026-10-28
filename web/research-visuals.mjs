// Pure aggregation of the existing /api/research response. No model calls or
// invented baseline values; all changes describe the collected sample only.
const count=v=>Number.isSafeInteger(v)&&v>=0?v:0;
export function matrixSeries(matrix={},monthly={}){
 const months=Object.keys(monthly).filter(m=>/^\d{4}-\d{2}$/.test(m)).sort();
 const labels=[...new Set(Object.keys(matrix).filter(k=>/^\d{4}-\d{2}\|.+/.test(k)).map(k=>k.split('|').slice(1).join('|')))];
 return {months,series:labels.map(name=>({name,values:months.map(m=>count(matrix[m+'|'+name]))}))};
}
export function annualMatrixSeries(matrix={}){
 const years=[...new Set(Object.keys(matrix).filter(k=>/^\d{4}-\d{2}\|.+/.test(k)).map(k=>k.slice(0,4)))].sort();
 const labels=[...new Set(Object.keys(matrix).filter(k=>/^\d{4}-\d{2}\|.+/.test(k)).map(k=>k.split('|').slice(1).join('|')))];
 return {months:years,series:labels.map(name=>({name,values:years.map(y=>Object.entries(matrix).reduce((n,[key,v])=>n+(key.startsWith(y+'-')&&key.slice(key.indexOf('|')+1)===name?count(v):0),0))}))};
}
export function matrixDistribution(matrix={}){
 const totals=new Map();
 for(const [key,value] of Object.entries(matrix)){const at=key.indexOf('|');if(at<0)continue;const name=key.slice(at+1);totals.set(name,(totals.get(name)||0)+count(value));}
 return [...totals].filter(([,n])=>n>0).map(([name,n])=>({name,n})).sort((a,b)=>b.n-a.n||a.name.localeCompare(b.name));
}
export function topicGrowth(report={},at=new Date()){
 const parts=new Intl.DateTimeFormat('en',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit'}).formatToParts(at);
 const end=new Date(Date.UTC(Number(parts.find(x=>x.type==='year').value),Number(parts.find(x=>x.type==='month').value)-1,1));
 const months=Array.from({length:12},(_,i)=>new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()-12+i,1)).toISOString().slice(0,7));
 const scope={previous:[months[0],months[5]],current:[months[6],months[11]],minimum:5};
 if(!months.every(m=>Object.hasOwn(report.monthly||{},m)))return {...scope,rows:[],reason:'需要连续 12 个完整月份的收录样本；当前观察范围不足。'};
 const data=matrixSeries(report.topics, Object.fromEntries(months.map(m=>[m,report.monthly[m]])));
 const rows=data.series.map(s=>{const previous=s.values.slice(0,6).reduce((a,b)=>a+b,0),current=s.values.slice(6).reduce((a,b)=>a+b,0);return {name:s.name,previous,current,change:previous>=5&&current>=5?(current-previous)/previous:null,values:s.values};}).filter(x=>x.change!==null).sort((a,b)=>b.change-a.change||b.current-a.current);
 return {...scope,rows,reason:rows.length?'':'前后窗口每个主题至少需 5 条记录；当前样本不足，不能计算变化率。'};
}
export function sampleBins(samples={},unit){
 const values=(samples[unit]||[]).filter(n=>Number.isSafeInteger(n)&&n>0);
 const bounds=[0,100,500,1000,5000,Infinity],labels=['1–99','100–499','500–999','1,000–4,999','5,000+'];
 return {unit,n:values.length,bins:labels.map((name,i)=>({name,n:values.filter(n=>n>=bounds[i]&&n<bounds[i+1]).length}))};
}
export function sourceDistribution(report={}){
 if(report.totals?.sources)return [...Object.entries(report.totals.sources).map(([name,n])=>({name,n:count(n)})),{name:'unknown',n:Math.max(0,count(report.n)-count(report.known?.data))}];
 const rows=matrixDistribution(report.sources),dated=rows.reduce((n,r)=>n+r.n,0),known=count(report.known?.data),total=count(report.n);
 const categories=['first_party_team_collection','secondary_public','secondary_restricted','administrative','mixed'];
 return [...categories.map(name=>({name,n:rows.find(r=>r.name===name)?.n||0})),{name:'unknown',n:Math.max(0,total-known)},{name:'undated_known',n:Math.max(0,known-dated)}];
}
