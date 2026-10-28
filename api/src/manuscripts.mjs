import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import {db,now} from './db.mjs';
export const manuscriptStatuses=['idea','writing','draft_done','revising','submitted','with_editor','under_review','major_revision','minor_revision','accepted','published','paused','rejected','transferred'];
db.exec(`CREATE TABLE IF NOT EXISTS lab_manuscript_details(manuscript_id TEXT PRIMARY KEY,coauthors TEXT NOT NULL DEFAULT '',coauthor_ids TEXT NOT NULL DEFAULT '[]',target_journals TEXT NOT NULL DEFAULT '',actual_submitted_journal TEXT NOT NULL DEFAULT '',expected_date TEXT NOT NULL DEFAULT '',work_type TEXT NOT NULL DEFAULT 'article',source_json TEXT);
CREATE TABLE IF NOT EXISTS lab_import_batches(id TEXT PRIMARY KEY,uploaded_by TEXT NOT NULL,file_hash TEXT NOT NULL,preview_json TEXT NOT NULL,created_at TEXT NOT NULL,confirmed_at TEXT,UNIQUE(uploaded_by,file_hash));
CREATE TABLE IF NOT EXISTS lab_import_rows(batch_id TEXT NOT NULL,source_row INTEGER NOT NULL,manuscript_id TEXT NOT NULL,PRIMARY KEY(batch_id,source_row));`);
export const titleKey=t=>String(t).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'');
const cellText=c=>{const v=c?.value;if(v===null||v===undefined)return '';if(typeof v==='object'){if(v.formula||v.sharedFormula)return '';if(v.richText)return v.richText.map(t=>t.text).join('').trim();if(v.text)return String(v.text).trim();return '';}return String(v).trim();};
export function parseStage(stage){const s=stage.toLowerCase();const mapping=[[/\baccepted\b|已录用/,'accepted'],[/\bpublished\b|已发表/,'published'],[/with\s*editor/,'with_editor'],[/under\s*review/,'under_review'],[/major\s*revision/,'major_revision'],[/minor\s*revision/,'minor_revision'],[/reject/,'rejected'],[/transfer/,'transferred'],[/submit/,'submitted'],[/draft\s*(done|complete)|初稿完成/,'draft_done'],[/revis/,'revising'],[/writ|framework|撰写/,'writing']];const status=mapping.find(([re])=>re.test(s))?.[1]||'idea';return {status,needs_review:!stage||status==='idea'||/刊出|发表/.test(stage)&&status==='accepted',basis:stage?'仅按单行 Stage 解析':'缺少 Stage，需人工确认；不继承分组状态'};}
export function validateWorkbookZip(buffer){
 // Bound expansion before ExcelJS allocates cell objects; formulas are never evaluated.
 let end=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65558);i--)if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0)throw Object.assign(Error('无效 XLSX ZIP'),{status:422});
 const count=buffer.readUInt16LE(end+10),offset=buffer.readUInt32LE(end+16);let at=offset,total=0;
 if(count>2000)throw Object.assign(Error('工作簿文件条目过多'),{status:413});
 for(let i=0;i<count;i++){if(at+46>buffer.length||buffer.readUInt32LE(at)!==0x02014b50)throw Object.assign(Error('不支持的 XLSX ZIP'),{status:422});total+=buffer.readUInt32LE(at+24);at+=46+buffer.readUInt16LE(at+28)+buffer.readUInt16LE(at+30)+buffer.readUInt16LE(at+32);if(total>30*1024*1024)throw Object.assign(Error('工作簿解压后超过 30MB'),{status:413});}
}
export async function previewWorkbook(buffer,user,filename='private-workbook.xlsx'){
 validateWorkbookZip(buffer);
 const hash=crypto.createHash('sha256').update(buffer).digest('hex');const prior=db.prepare('SELECT * FROM lab_import_batches WHERE uploaded_by=? AND file_hash=?').get(user.id,hash);if(prior)return {batch_id:prior.id,...JSON.parse(prior.preview_json),confirmed:!!prior.confirmed_at};
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);const sheet=workbook.getWorksheet('论文写作与发表');if(!sheet)throw Object.assign(Error('缺少「论文写作与发表」工作表'),{status:422});if(sheet.rowCount>1000)throw Object.assign(Error('最多 1000 行'),{status:413});
 const existing=db.prepare('SELECT id,title FROM lab_manuscripts').all();const rows=[],skipped=[];let group='';
 sheet.eachRow((r,index)=>{if(index===1)return;const label=cellText(r.getCell(1));if(label)group=label;const title=cellText(r.getCell(2));if(!title||/^\*|其他备选题目/.test(group)||/DISPIMG\s*\(/i.test(title)){skipped.push(index);return;}
 const raw={group,title,stage:cellText(r.getCell(3)),journal:cellText(r.getCell(4)),lead_author:cellText(r.getCell(5)),other_author:cellText(r.getCell(6))};
 const norm=titleKey(title),duplicate=existing.find(e=>titleKey(e.title)===norm),possible=existing.filter(e=>{const k=titleKey(e.title);return k!==norm&&(k.includes(norm)||norm.includes(k))}).map(e=>({id:e.id,title:e.title}));
 rows.push({source_workbook:String(filename).slice(0,180),source_sheet:sheet.name,source_row:index,raw,...parseStage(raw.stage),work_type:/\bbook\b|图书|专著/i.test(title)?'other':'article',duplicate_id:duplicate?.id||null,possible_duplicates:possible});});
 const id=crypto.randomUUID(),preview={rows,skipped,warning:'姓名保留原文；请逐行选择负责人并审核阶段。项目和专报工作表不自动导入。'};
 db.prepare('INSERT INTO lab_import_batches VALUES(?,?,?,?,?,NULL)').run(id,user.id,hash,JSON.stringify(preview),now());return {batch_id:id,...preview,confirmed:false};
}
export function manuscriptDetails(id){return db.prepare('SELECT coauthors,coauthor_ids,target_journals,actual_submitted_journal,expected_date,work_type FROM lab_manuscript_details WHERE manuscript_id=?').get(id)||{};}
export function saveManuscriptDetails(id,b){const old=manuscriptDetails(id);const keys=['coauthors','target_journals','actual_submitted_journal','expected_date'];const values=keys.map(k=>String(b[k]??old[k]??'').trim().slice(0,1500));const coauthors=Array.isArray(b.coauthor_ids)?b.coauthor_ids.filter(x=>db.prepare('SELECT 1 FROM lab_users WHERE id=? AND active=1').get(x)):JSON.parse(old.coauthor_ids||'[]');db.prepare(`INSERT INTO lab_manuscript_details(manuscript_id,coauthors,target_journals,actual_submitted_journal,expected_date,coauthor_ids,work_type) VALUES(?,?,?,?,?,?,?) ON CONFLICT(manuscript_id) DO UPDATE SET coauthors=excluded.coauthors,target_journals=excluded.target_journals,actual_submitted_journal=excluded.actual_submitted_journal,expected_date=excluded.expected_date,coauthor_ids=excluded.coauthor_ids,work_type=excluded.work_type`).run(id,...values,JSON.stringify(coauthors),b.work_type||old.work_type||'article');}
export function confirmImport(batch,user,choices){
 const b=db.prepare('SELECT * FROM lab_import_batches WHERE id=? AND uploaded_by=?').get(batch,user.id);if(!b)throw Object.assign(Error('导入批次不存在'),{status:404});if(b.confirmed_at)return {imported:0,already_confirmed:true};
 if(!choices.length)throw Object.assign(Error('至少选择一行'),{status:400});
 const rows=JSON.parse(b.preview_json).rows,existing=db.prepare('SELECT id,title FROM lab_manuscripts').all();let imported=0,skipped=0;
 db.exec('BEGIN IMMEDIATE');try{for(const choice of choices){const r=rows.find(x=>x.source_row===choice.source_row);if(!r)throw Object.assign(Error('源行号不正确'),{status:400});if(existing.some(x=>titleKey(x.title)===titleKey(r.raw.title))){skipped++;continue;}
 const owner=String(choice.owner_id||'');if(!db.prepare('SELECT 1 FROM lab_users WHERE id=? AND active=1').get(owner)||!manuscriptStatuses.includes(choice.status))throw Object.assign(Error('必须人工指定有效负责人和阶段'),{status:400});
 const id=crypto.randomUUID();db.prepare('INSERT INTO lab_manuscripts(id,title,owner_id,status,updated_at,created_by) VALUES(?,?,?,?,?,?)').run(id,r.raw.title,owner,choice.status,now(),user.id);
 saveManuscriptDetails(id,{coauthors:r.raw.other_author,target_journals:r.raw.journal,work_type:r.work_type});
 db.prepare('UPDATE lab_manuscript_details SET source_json=? WHERE manuscript_id=?').run(JSON.stringify({batch_id:batch,...r}),id);
 db.prepare('INSERT INTO lab_import_rows VALUES(?,?,?)').run(batch,r.source_row,id);
 db.prepare('INSERT INTO lab_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),'manuscript',id,'excel_import','lab','审核后导入论文','{}',JSON.stringify({title:r.raw.title,status:choice.status}),null,null,user.id,now());existing.push({id,title:r.raw.title});imported++;
 }db.prepare('UPDATE lab_import_batches SET confirmed_at=? WHERE id=?').run(now(),batch);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e}return {imported,skipped};
}
const excelSafe=s=>/^[=+@\-\t\r]/.test(String(s))?"'"+s:String(s||'');
export async function exportManuscripts(){const w=new ExcelJS.Workbook(),s=w.addWorksheet('论文写作与发表');s.addRow(['','Topic/Title','Stage','Target journal','Lead author','Other author','Actual submitted journal','Next step']);for(const m of db.prepare('SELECT m.*,u.name FROM lab_manuscripts m JOIN lab_users u ON u.id=m.owner_id ORDER BY m.title').all()){const d=manuscriptDetails(m.id);s.addRow(['',m.title,m.status,d.target_journals,m.name,d.coauthors,d.actual_submitted_journal,m.next_step].map(excelSafe));}return w.xlsx.writeBuffer();}
