import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const env = process.env;
export const config = {
  root, port:Number(env.PORT || 8787), dbPath:env.DATABASE_PATH || path.join(root,'data','fanscope.sqlite'),
  adminKey:env.ADMIN_KEY || '', origins:(env.ALLOWED_ORIGINS || 'http://localhost:4173,http://127.0.0.1:4173').split(',').map(s=>s.trim()).filter(Boolean),
  frontendUrl:env.PUBLIC_FRONTEND_URL || 'http://localhost:4173', apiUrl:env.PUBLIC_API_URL || `http://127.0.0.1:${env.PORT||8787}`,
  contactEmail:env.CROSSREF_CONTACT_EMAIL || '', intervalMinutes:Math.max(30,Number(env.SCAN_INTERVAL_MINUTES||120)),
  scanOnStart:env.SCAN_ON_START !== 'false', initialLookbackDays:Math.min(180,Math.max(1,Number(env.INITIAL_LOOKBACK_DAYS||30))),
  maxPages:Math.min(20,Math.max(1,Number(env.MAX_CROSSREF_PAGES||4))),
  maxAI:Math.min(5,Math.max(0,Number(env.MAX_AI_PER_SCAN||2))),
  dsKey:env.DEEPSEEK_API_KEY||'', dsModel:env.DEEPSEEK_MODEL||'deepseek-flash',
  resendKey:env.RESEND_API_KEY||'', emailFrom:env.EMAIL_FROM||'',
  tz:env.TIME_ZONE||'Asia/Shanghai', publicSubscriptions:env.ENABLE_PUBLIC_SUBSCRIPTIONS!=='false'
};
export const journals=JSON.parse(fs.readFileSync(path.join(root,'config','journals.json'),'utf8'));
export const topics=JSON.parse(fs.readFileSync(path.join(root,'config','topics.json'),'utf8'));
