import {db} from './db.mjs';
import {hashPassword,createUser} from './lab.mjs';
const [cmd,name,email,role,password]=process.argv.slice(2);
if(cmd==='create-user'){
 if(!name||!email||!role||!password){console.error('Usage: npm run lab:user -- create-user "Name" email@school.edu mentor|lab_admin|member PASSWORD');process.exit(2);}
 try{const user=createUser({name,email,role,password});console.log('Created user',user.name,user.email,user.role);}catch(e){console.error('Failed:',e.message);process.exit(1);}
}else if(cmd==='reset-password'){
 const userEmail=name,newPassword=email;
 if(!userEmail||!newPassword){console.error('Usage: npm run lab:user -- reset-password email@school.edu NEW_PASSWORD');process.exit(2);}
 try{const hash=hashPassword(newPassword);const result=db.prepare('UPDATE lab_users SET password_hash=? WHERE email=?').run(hash,userEmail.toLowerCase());if(!result.changes)throw Error('User not found');const userid=db.prepare('SELECT id FROM lab_users WHERE email=?').get(userEmail.toLowerCase()).id;db.prepare('DELETE FROM lab_sessions WHERE user_id=?').run(userid);console.log('Password reset; existing sessions invalidated for',userEmail);}catch(e){console.error('Failed:',e.message);process.exit(1);}
}else{console.error('Usage: create-user or reset-password');process.exit(2);}
