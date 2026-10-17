const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
if(fs.existsSync(path.join(__dirname,'.env')))process.loadEnvFile(path.join(__dirname,'.env'));
const directory=path.resolve(process.env.DATA_DIR||path.join(__dirname,'data')),source=path.join(directory,'invoice-studio.sqlite');
if(!fs.existsSync(source)){console.error('Start Invoice Studio and create your account before making a database backup.');process.exitCode=1;}
else{
  const backups=path.join(directory,'backups');fs.mkdirSync(backups,{recursive:true});
  const target=path.join(backups,`invoice-studio-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`),db=new DatabaseSync(source);
  try{db.exec('PRAGMA busy_timeout=10000');db.prepare('VACUUM INTO ?').run(target);console.log('Database backup saved to '+target);}
  finally{db.close();}
}
