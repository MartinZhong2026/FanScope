// Both baseline and fixed builds use exactly these isolated, labelled fixtures.
// Never point this script at a business database or a remote API.
import path from 'node:path';import {pathToFileURL} from 'node:url';
process.env.ADMIN_KEY='qa-only-admin-key-12345678901234567890';
const root=path.resolve(process.env.ACCEPTANCE_BASELINE_ROOT||path.join(import.meta.dirname,'../..'));
await import(pathToFileURL(path.join(root,'api/test/mobile-browser-server.mjs')));
const {db,now}=await import(pathToFileURL(path.join(root,'api/src/db.mjs')));
const {insertArticle}=await import(pathToFileURL(path.join(root,'api/src/monitor.mjs')));
const {analysisFingerprint}=await import(pathToFileURL(path.join(root,'api/src/ai.mjs')));
const {publicationToday}=await import(pathToFileURL(path.join(root,'api/src/publication-policy.mjs')));
const day=d=>new Date(Date.parse(publicationToday()+'T00:00:00Z')+d*86400000).toISOString().slice(0,10);
for(let i=0;i<35;i++)insertArticle({id:'quality-extra-'+i,journal_id:'jmir',market:'international',title:'[隔离验收数据] 历史补录 '+i,publication_date:'2024-02-01',source:'manual',topics:[]});
for(const [id,d] of [['recent-0',0],['recent-1',-1],['recent-2',-2],['backfill',-150],['future',1]])insertArticle({id:'quality-'+id,journal_id:'jmir',market:'international',title:'[隔离验收数据] '+id+' · 发表日与收录日独立',publication_date:day(d),source:'manual',topics:[]});
db.prepare("UPDATE articles SET discovered_at='2099-01-01' WHERE id='quality-backfill'").run();
for(let i=0;i<3;i++){
 const abstract='A cohort of 500 persons was followed using survival analysis and public administrative data. Isolated acceptance evidence only.';
 insertArticle({id:'quality-small-'+i,journal_id:'jmir',market:'international',title:'[隔离验收数据] QUALITY-SMALL-'+i,publication_date:day(-30-i),abstract,topics:i===2?['ai']:['care'],source:'manual'});
 const a=db.prepare('SELECT * FROM articles WHERE id=?').get('quality-small-'+i),e=quote=>({quote,confidence:.9});
 const x=i===2?{study_design:'unknown',statistical_methods:[],data_source_type:'unknown',sample_n:null,sample_unit:null,evidence:{}}:{study_design:'cohort',statistical_methods:['survival'],data_source_type:'administrative',sample_n:500,sample_unit:'person',evidence:{study_design:e('A cohort of 500 persons'),'method:survival':e('using survival analysis'),data_source_type:e('public administrative data'),sample_n:e('500 persons was followed'),sample_unit:e('500 persons was followed')}};
 db.prepare("UPDATE articles SET analysis_status='analyzed',analysis_json=?,analysis_input_hash=?,analysis_normalized_hash=? WHERE id=?").run(JSON.stringify(x),analysisFingerprint(a),analysisFingerprint(a),a.id);
}
db.prepare("UPDATE journals SET title='Journal of Medical Internet Research — [隔离验收数据] International Journal with a Long Unabridged Journal Name' WHERE id='jmir'").run();
const articles=db.prepare('SELECT id FROM articles ORDER BY id LIMIT 200').all();
for(const total of [200,164]){
 const id='quality-batch-'+total;
 db.prepare('INSERT INTO analysis_batches(id,created_at,status,filter_json,total) VALUES(?,?,?,?,?)').run(id,now(),total===200?'running':'completed',JSON.stringify({yearFrom:2026,yearTo:2026,policy:'custom'}),total);
 for(let i=0;i<total;i++)db.prepare('INSERT INTO analysis_batch_items(batch_id,article_id,status,error,updated_at) VALUES(?,?,?,?,?)').run(id,articles[i].id,i<100?'completed':i<150?'cached':i<164?'failed':i===164?'running':'queued',i>=150&&i<164?'DeepSeek '+(i<158?'invalid_json':'request_uncertain'):'',now());
 const usage=db.prepare('INSERT INTO analysis_usage_log(article_id,batch_id,model,input_tokens,output_tokens,cost_cny,created_at,status,error_code) VALUES(?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<114;i++)usage.run(articles[i].id,id,'acceptance-mock',i<100?900:0,i<100?220:0,i<100?.00178:.036384,now(),i<100?'completed':'uncertain',i>=100?(i<108?'invalid_json':'request_uncertain'):null);
}
console.log('Quality acceptance: labelled 200/164 batches only; no workers started.');
