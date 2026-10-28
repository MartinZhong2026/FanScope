// Operator control only; never sends an AI request.
import fs from 'node:fs';
if(!process.env.DATABASE_PATH||!fs.existsSync(process.env.DATABASE_PATH))throw Error('Existing DATABASE_PATH required');
const action=process.argv.find(x=>x.startsWith('--action='))?.slice(9)||'status';
const {automaticStatus,changeAutomatic}=await import('./automatic-ai.mjs');const {db}=await import('./db.mjs');
try{console.log(JSON.stringify(action==='status'?automaticStatus():changeAutomatic(action)));}finally{db.close()}
