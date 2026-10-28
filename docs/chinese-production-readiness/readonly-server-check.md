# 已登录服务器终端的只读核查

本机唯一一次非交互SSH连接被服务器关闭，不再重试。请本人在现有已登录的ubuntu终端执行。以下不运行应用、不读取.env、不输出环境密钥、不复制数据库、不重启；sudo -n失败即停，不发送密码或私钥。

```bash
cd /home/ubuntu/fanscope
pwd
sudo -n docker ps --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'
# 容器名称不同则按上段真实结果替换，不猜其他容器。
sudo -n docker inspect --format '{{.Image}} {{.State.Status}}' fanscope-api
sudo -n docker inspect --format '{{json .Mounts}}' fanscope-api
sudo -n docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.project.config_files"}} {{index .Config.Labels "com.docker.compose.project.working_dir"}}' fanscope-api
IMAGE_ID=$(sudo -n docker inspect --format '{{.Image}}' fanscope-api)
sudo -n docker image inspect --format '{{.Id}} {{.Created}} {{json .RepoDigests}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_ID"
df -h /home/ubuntu/fanscope
find /home/ubuntu/fanscope-private-backups -maxdepth 2 -type f -printf '%TY-%Tm-%Td %TH:%TM %s %p\n' 2>/dev/null
```

Compose文件路径以容器标签为准；如确为下述路径，可仅输出允许字段。不要直接打印完整config或inspect。旧Compose不支持参数时停止该项。

```bash
sudo -n docker compose -f deploy/docker-compose.yml config --no-env-resolution --no-interpolate --format json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(json.dumps({"name":d.get("name"),"services":{k:{x:v.get(x) for x in ["image","build","ports","volumes","restart"]} for k,v in d.get("services",{}).items()},"volumes":d.get("volumes",{})},ensure_ascii=False,indent=2))'
```

下段仅Node内置SQLite只读事务，不导入项目模块，不输出论文、用户或分析内容。DB路径未配置则停止；WAL缺少既有SHM时停止，避免新建SHM。禁止改用immutable忽略WAL。若Node不支持内置SQLite则停止，不安装软件。

```bash
sudo -n docker exec -i fanscope-api node --experimental-sqlite --input-type=module <<'NODE'
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const file=process.env.DATABASE_PATH;
if(!file||!fs.existsSync(file))throw Error('DATABASE_PATH未配置或不存在，停止');
console.log(JSON.stringify({database:file,bytes:fs.statSync(file).size,wal:fs.existsSync(file+'-wal'),shm:fs.existsSync(file+'-shm')}));
if(fs.existsSync(file+'-wal')&&!fs.existsSync(file+'-shm'))throw Error('WAL无现有SHM，停止');
const db=new DatabaseSync(file,{readOnly:true});
db.exec('BEGIN');
try{
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name);
 const q=s=>'"'+s.replaceAll('"','""')+'"';
 for(const name of tables)console.log(JSON.stringify({table:name,count:db.prepare('SELECT COUNT(*) n FROM '+q(name)).get().n}));
 if(tables.includes('articles')){
  const cols=db.prepare('PRAGMA table_info(articles)').all().map(x=>x.name);
  if(cols.includes('market'))console.log(JSON.stringify({articleMarkets:db.prepare('SELECT market,COUNT(*) n FROM articles GROUP BY market').all()}));
  if(cols.includes('analysis_json'))console.log(JSON.stringify({analyzed:db.prepare("SELECT COUNT(*) n FROM articles WHERE analysis_json IS NOT NULL AND analysis_json!=''").get().n}));
 }
 console.log(JSON.stringify({userVersion:db.prepare('PRAGMA user_version').get()}));
}finally{db.exec('ROLLBACK');db.close();}
NODE
```

请提供脱敏结果，保留卷名与容器内路径对应关系。备份文件存在不代表一致性或可恢复；实际备份与演练等待下一次明确授权。
