if(!process.env.DATABASE_PATH)throw Error('Set DATABASE_PATH to an isolated acceptance database');process.env.SCAN_ON_START='false';process.env.ALLOWED_ORIGINS='http://127.0.0.1:4173,https://fanscope.pages.dev';process.env.DEEPSEEK_API_KEY='local-offline-mock';
const {db}=await import('../src/db.mjs');const {createUser}=await import('../src/lab.mjs');const {insertArticle}=await import('../src/monitor.mjs');const {makeServer}=await import('../src/server.mjs');
if(!db.prepare('SELECT 1 FROM lab_users LIMIT 1').get()){
 createUser({name:'本地验收管理员',email:'acceptance@example.org',role:'mentor',password:'Acceptance-only-password'});
 createUser({name:'本地验收成员',email:'member@example.org',password:'Acceptance-only-password'});
 for(let i=0;i<40;i++){
 const id='doi:10.9999/acceptance-'+i,publication_date=i<20?'2025-'+String(1+i%12).padStart(2,'0')+'-15':'2026-'+String(1+i%10).padStart(2,'0')+'-15';
 insertArticle({id,journal_id:i%2?'jmir':'ssm',market:'international',title:'本地验收合成数据 · Caregiving study '+i,doi:'10.9999/acceptance-'+i,abstract:'Synthetic abstract for local acceptance only: A cohort of 500 persons was followed using survival analysis.',publication_date,source:'manual',topics:['care'],matched:true});
 const x={study_design:'cohort',statistical_methods:['survival'],data_source_type:'secondary_public',sample_n:500+i*10,sample_unit:i%2?'household':'person',evidence:{sample_n:{quote:'Synthetic acceptance evidence only',confidence:1}},extraction_scope:'abstract-only',provider:'offline-acceptance',model:'mock'};
 db.prepare("UPDATE articles SET analysis_status='analyzed',analysis_json=?,ai_summary='本地验收合成摘要，不代表真实研究' WHERE id=?").run(JSON.stringify(x),id);
 }
}
globalThis.fetch=async(url,options)=>{if(String(url)==='https://api.deepseek.com/chat/completions'){
 const project=db.prepare('SELECT id FROM lab_projects LIMIT 1').get();return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({updates:project?[{entity_type:'project',entity_id:project.id,status:'waiting',summary:'本地验收建议更新，等待人工确认',next_step:'人工确认后继续',source_quote:'本地验收项目已经完成本轮方案讨论'}]:[]})}}]}));}throw Error('Acceptance server blocks external API calls');};
makeServer().listen(8787,'127.0.0.1',()=>console.log('Local acceptance API ready'));
