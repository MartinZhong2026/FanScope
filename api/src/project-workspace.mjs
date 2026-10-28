import crypto from 'node:crypto';
import {db,now} from './db.mjs';
db.exec(`CREATE TABLE IF NOT EXISTS lab_project_members(project_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(project_id,user_id));
CREATE TABLE IF NOT EXISTS lab_project_workspace(project_id TEXT PRIMARY KEY,owner_id TEXT,start_date TEXT DEFAULT '',due_date TEXT DEFAULT '',stage TEXT DEFAULT '',progress_mode TEXT DEFAULT 'milestones');
CREATE TABLE IF NOT EXISTS lab_milestones(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',weight REAL NOT NULL DEFAULT 1,due_date TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS lab_tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,assignee_id TEXT,status TEXT NOT NULL DEFAULT 'todo',blocker TEXT DEFAULT '',due_date TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS lab_task_notes(task_id TEXT PRIMARY KEY,summary TEXT DEFAULT '',next_step TEXT DEFAULT '',updated_at TEXT);
CREATE TABLE IF NOT EXISTS lab_project_records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,document_id TEXT,actor_id TEXT NOT NULL,created_at TEXT NOT NULL);`);
export function workspace(projectId,u){
 const info=db.prepare('SELECT * FROM lab_project_workspace WHERE project_id=?').get(projectId)||{};
 const members=db.prepare('SELECT u.id,u.name FROM lab_project_members m JOIN lab_users u ON u.id=m.user_id WHERE m.project_id=?').all(projectId);
 const milestones=db.prepare('SELECT * FROM lab_milestones WHERE project_id=? ORDER BY due_date,id').all(projectId),tasks=db.prepare('SELECT t.*,n.summary,n.next_step FROM lab_tasks t LEFT JOIN lab_task_notes n ON n.task_id=t.id WHERE project_id=? ORDER BY due_date,t.id').all(projectId);
 const weight=milestones.reduce((n,m)=>n+m.weight,0),completed=milestones.filter(m=>m.status==='completed').reduce((n,m)=>n+m.weight,0);
 const records=db.prepare('SELECT id,kind,title,document_id,created_at FROM lab_project_records WHERE project_id=? ORDER BY created_at DESC').all(projectId).map(r=>({...r,document_id:r.document_id&&(u.role==='mentor'||db.prepare('SELECT 1 FROM lab_documents WHERE id=? AND uploaded_by=?').get(r.document_id,u.id))?r.document_id:null}));
 return {info,members,milestones,tasks,records,progress:info.progress_mode==='exploratory'?null:weight?Math.round(100*completed/weight):null,progress_definition:'已完成里程碑权重 / 全部里程碑权重；无里程碑时不计算'};
}
export function updateWorkspace(projectId,action,b,u){
 const text=(s,max=800)=>String(s||'').trim().slice(0,max),fail=msg=>{throw Object.assign(Error(msg),{status:400})};
 const user=id=>!id||db.prepare('SELECT 1 FROM lab_users WHERE id=? AND active=1').get(id);
 if(action==='workspace'){
  if(!user(b.owner_id))fail('负责人不存在');if(!['milestones','exploratory'].includes(b.progress_mode||'milestones'))fail('进度模式不正确');
  for(const k of ['start_date','due_date'])if(b[k]&&!/^\d{4}-\d{2}-\d{2}$/.test(b[k]))fail('日期格式不正确');
  db.prepare('INSERT INTO lab_project_workspace VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET owner_id=excluded.owner_id,start_date=excluded.start_date,due_date=excluded.due_date,stage=excluded.stage,progress_mode=excluded.progress_mode').run(projectId,b.owner_id||null,text(b.start_date,10),text(b.due_date,10),text(b.stage,100),b.progress_mode||'milestones');
 }else if(action==='members'){
  if(!b.user_id||!user(b.user_id))fail('成员不存在');db.prepare('INSERT OR IGNORE INTO lab_project_members VALUES(?,?)').run(projectId,b.user_id);
 }else if(action==='milestones'){
  if(!text(b.title))fail('里程碑名称必填');const status=b.status||'pending',weight=Number(b.weight??1);if(!['pending','active','completed','blocked'].includes(status)||!Number.isFinite(weight)||weight<=0||weight>100)fail('状态或权重不正确');
  if(b.id&&!db.prepare('SELECT 1 FROM lab_milestones WHERE id=? AND project_id=?').get(b.id,projectId))fail('里程碑不存在');
  db.prepare('INSERT INTO lab_milestones VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,weight=excluded.weight,due_date=excluded.due_date').run(b.id||crypto.randomUUID(),projectId,text(b.title),status,weight,text(b.due_date,10));
 }else if(action==='tasks'){
  if(!text(b.title)||!user(b.assignee_id)||!['todo','active','blocked','done'].includes(b.status||'todo'))fail('任务、责任人或状态不正确');
  if(b.id&&!db.prepare('SELECT 1 FROM lab_tasks WHERE id=? AND project_id=?').get(b.id,projectId))fail('任务不存在');
  const taskId=b.id||crypto.randomUUID();db.prepare('INSERT INTO lab_tasks VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,assignee_id=excluded.assignee_id,status=excluded.status,blocker=excluded.blocker,due_date=excluded.due_date').run(taskId,projectId,text(b.title),b.assignee_id||null,b.status||'todo',text(b.blocker),text(b.due_date,10));
  if(b.next_step!==undefined)db.prepare('INSERT INTO lab_task_notes(task_id,next_step,updated_at) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET next_step=excluded.next_step,updated_at=excluded.updated_at').run(taskId,text(b.next_step),now());
 }else if(action==='records'){
  if(!text(b.title)||!['file','meeting','interview','decision'].includes(b.kind))fail('记录类型或名称不正确');
  if(b.document_id&&!db.prepare("SELECT 1 FROM lab_documents WHERE id=? AND (uploaded_by=? OR ?='mentor')").get(b.document_id,u.id,u.role))fail('无权关联此原始文件');
  db.prepare('INSERT INTO lab_project_records VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),projectId,b.kind,text(b.title),b.document_id||null,u.id,now());
 }else fail('未知工作台操作');
 db.prepare('UPDATE lab_projects SET updated_at=? WHERE id=?').run(now(),projectId);
 db.prepare('INSERT INTO lab_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),'project',projectId,'workspace','lab','更新项目'+action,'{}',JSON.stringify({action}),null,null,u.id,now());
}
