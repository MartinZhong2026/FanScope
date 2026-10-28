// Browser acceptance only. Refuse to use an existing/business database.
import fs from 'node:fs';
import path from 'node:path';
const dbPath=process.env.DATABASE_PATH;
if(!dbPath||!dbPath.includes('/work/')||fs.existsSync(dbPath))throw Error('Use a NEW database under work/ for mobile browser acceptance');
process.env.SCAN_ON_START='false';process.env.AUTO_AI_ANALYSIS='false';process.env.DEEPSEEK_API_KEY='';
const {db,now}=await import('../src/db.mjs');
const {createUser}=await import('../src/lab.mjs');
const {insertArticle}=await import('../src/monitor.mjs');
const {analysisFingerprint}=await import('../src/ai.mjs');
const {updateWorkspace}=await import('../src/project-workspace.mjs');
const password='Mobile-acceptance-only';
const mentor=createUser({name:'验收导师',email:'mentor@mobile.test',password,role:'mentor'});
const admin=createUser({name:'验收管理员',email:'admin@mobile.test',password,role:'lab_admin'});
const member=createUser({name:'验收成员',email:'member@mobile.test',password,role:'member'});
const other=createUser({name:'另一位验收成员',email:'other@mobile.test',password,role:'member'});
const userId=x=>typeof x==='string'?x:x.id;
const mentorId=userId(mentor),memberId=userId(member),otherId=userId(other);
const year=new Date().getUTCFullYear(),today=new Date().toISOString().slice(0,10);
for(let i=0;i<165;i++){
 const publication=new Date(Date.UTC(year,new Date().getUTCMonth()-i%18,Math.min(15,new Date().getUTCDate()))).toISOString().slice(0,10);
 const sampleN=100+(i%20)*70,unit=i%5===0?'household':'person',noun=unit==='person'?'persons':'households';
 const chinese=i%3===0,abstract=`A cohort of ${sampleN} ${noun} was followed using survival analysis. Synthetic acceptance fixture, not a published research finding.`;
 const a={id:'mobile-paper-'+i,journal_id:chinese?'candidate-1':'jmir',market:chinese?'chinese':'international',title:`[隔离验收数据] ${chinese?'照护与老龄健康的队列研究：城市与社区支持网络的长期观察':'Caregiving and healthy ageing: longitudinal evidence from community support networks'} ${i}`,abstract,doi:'10.9999/mobile-'+i,publication_date:publication,source:'manual',topics:[['care','climate','ai','poverty'][i%4],...(i%3===0?['care']:[])].filter((v,n,a)=>a.indexOf(v)===n),matched:true};insertArticle(a);
 const x={study_design:'cohort',statistical_methods:['survival'],data_source_type:'unknown',sample_n:sampleN,sample_unit:unit,extraction_scope:'abstract-only',provider:'acceptance-fixture',model:'none',evidence:{study_design:{quote:`A cohort of ${sampleN} ${noun}`,confidence:.9},'method:survival':{quote:'using survival analysis',confidence:.9},sample_n:{quote:`${sampleN} ${noun} was followed`,confidence:.9},sample_unit:{quote:`${sampleN} ${noun} was followed`,confidence:.9}}};
 const row=db.prepare('SELECT * FROM articles WHERE doi=?').get(a.doi);
 db.prepare("UPDATE articles SET article_type='original_research',article_type_evidence_json=?,analysis_status='analyzed',analysis_json=?,analysis_normalized_hash=?,analysis_input_hash=?,design='cohort',method='survival',sample_n=?,sample_unit=? WHERE id=?").run('{"source":"acceptance-fixture"}',JSON.stringify(x),analysisFingerprint(row),analysisFingerprint(row),sampleN,unit,row.id);
}
for(const [id,title] of [['mobile-project','[隔离验收数据] 社区照护与健康老龄化'],['mobile-project-2','[隔离验收数据] 学术协作与研究设计']]){
 db.prepare('INSERT INTO lab_projects VALUES(?,?,?,?,?,?,?)').run(id,title,'仅用于浏览器验收，非真实课题。','active','整理访谈提纲并核对研究方案',now(),mentorId);
 updateWorkspace(id,'workspace',{owner_id:memberId,stage:'研究设计',progress_mode:'milestones'}, {id:mentorId});
 updateWorkspace(id,'milestones',{title:'研究方案核对',status:'completed',weight:1}, {id:mentorId});
 updateWorkspace(id,'milestones',{title:'访谈准备',status:'pending',weight:1}, {id:mentorId});
}
for(let i=0;i<3;i++)db.prepare('INSERT INTO lab_manuscripts(id,title,owner_id,project_id,status,updated_at,created_by) VALUES(?,?,?,?,?,?,?)').run('mobile-ms-'+i,'[隔离验收数据] 社区照护研究论文 '+i,memberId,'mobile-project','writing',now(),mentorId);
db.prepare('INSERT INTO lab_member_updates VALUES(?,?,?,?,?,?)').run('mobile-private',otherId,'active','PRIVATE_FIXTURE_ONLY_OTHER_AND_MENTOR','保留私人记录',now());
const file=path.join(path.dirname(dbPath),'mobile-review.txt');fs.writeFileSync(file,'[隔离验收资料] 本轮研究方案完成讨论，下一步整理访谈提纲。'.repeat(4));
db.prepare('INSERT INTO lab_documents VALUES(?,?,?,?,?,?,?,?,?,?)').run('mobile-doc','[隔离验收数据] 组会记录.txt','text/plain',file,otherId,now(),100,'ready','','mobile-fixture-only');
for(const [id,summary] of [['mobile-approve','建议核对研究方案'],['mobile-reject','建议推进访谈准备']])db.prepare('INSERT INTO lab_suggestions(id,document_id,entity_type,entity_id,status,summary,next_step,source_quote,confidence) VALUES(?,?,?,?,?,?,?,?,?)').run(id,'mobile-doc','project','mobile-project','active',summary,'人工确认后执行','本轮研究方案完成讨论，下一步整理访谈提纲。',.9);
// Reuse the existing static/API fixture transport. Its outbound fetch is mocked.
await import('./browser-v13-server.mjs');
console.log('Mobile acceptance fixtures ready. No production DB or external AI calls.');
