import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
process.env.DATABASE_PATH=path.join(os.tmpdir(),`fanscope-v13-onboarding-${process.pid}.sqlite`);
const {db}=await import('../src/db.mjs');
const {probeJournalSource,sourceSummary}=await import('../src/journal-onboarding.mjs');
after(()=>{db.close();for(const ext of ['','-wal','-shm'])fs.rmSync(process.env.DATABASE_PATH+ext,{force:true});});
const valid=async()=>({message:{items:[{type:'journal-article',ISSN:['1234-5679'],DOI:'10.1234/example',title:['Paper from verified issuer'], 'container-title':[testJournalTitle]}]}});
let testJournalTitle='';
const invalid=async()=>({message:{items:[{type:'journal-article',ISSN:['9999-9999'],DOI:'10.1234/wrong'}]}});
test('Crossref source cannot be enabled without matching DOI / ISSN and confirmation',async()=>{
 const j=db.prepare("SELECT id,title,enabled FROM journals WHERE market='international' AND enabled=0 LIMIT 1").get();assert.ok(j);testJournalTitle=j.title;
 const probe=await probeJournalSource({id:j.id,issn:'1234-5679'},valid);assert.equal(probe.verified,true);assert.equal(probe.enabled,false);
 await assert.rejects(probeJournalSource({id:j.id,issn:'1234-5679',enable:true},valid),/confirmation/);
 await assert.rejects(probeJournalSource({id:j.id,issn:'1234-5679',enable:true,confirm:true},invalid),/identity/);
 assert.equal(db.prepare('SELECT enabled FROM journals WHERE id=?').get(j.id).enabled,0);
 const live=await probeJournalSource({id:j.id,issn:'1234-5679',enable:true,confirm:true},valid);assert.equal(live.enabled,true);
 const s=sourceSummary();assert.equal(s.enabled,6);assert.equal(s.total,JSON.parse(fs.readFileSync(new URL('../config/journals.json',import.meta.url))).length);
});
