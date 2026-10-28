// Operator-only commands executed inside the backend container.
import {createBatch,listBatches,batchDetail,changeBatch,workBatchTick,coverage} from './analysis-batches.mjs';
import {currentResearchYear} from './publication-policy.mjs';
const [action,idOrFlag,...args]=process.argv.slice(2);
const flags=Object.fromEntries([idOrFlag,...args].filter(s=>s?.startsWith('--')).map(s=>{const [k,...v]=s.slice(2).split('=');return [k,v.join('=')]}));
try{
 let result;
 if(action==='create')result=createBatch({yearFrom:Number(flags.from||currentResearchYear()),yearTo:Number(flags.to||currentResearchYear()),limit:Number(flags.limit||150),policy:flags.policy||'trend_candidates',journalId:flags.journal||''});
 else if(action==='list')result=listBatches();
 else if(action==='coverage')result=coverage();
 else if(action==='status')result=batchDetail(idOrFlag);
 else if(['start','pause','cancel'].includes(action))result=changeBatch(idOrFlag,action);
 else if(action==='tick')result=await workBatchTick(1);
 else throw Error('Usage: analysis:cli create --from=2026 --to=2026 --limit=150 [--policy=custom] [--journal=ID] | list | status ID | start ID | pause ID | cancel ID | coverage | tick');
 console.log(JSON.stringify(result,null,2));
}catch(e){console.error('Analysis CLI:',e.message);process.exitCode=1;}
