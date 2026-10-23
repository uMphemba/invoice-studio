const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
if(fs.existsSync(path.join(__dirname,'.env')))process.loadEnvFile(path.join(__dirname,'.env'));
const Finance=require('./public/finance');
const Document=require('./public/document');
const {imageData}=require('./image');
const createServices=require('./services');

const root=__dirname,dataDir=path.resolve(process.env.DATA_DIR||path.join(root,'data'));
fs.mkdirSync(dataDir,{recursive:true});
const db=new DatabaseSync(path.join(dataDir,'invoice-studio.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS businesses(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,profile TEXT NOT NULL,design TEXT NOT NULL,logo BLOB,logo_type TEXT,next_number INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),data TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),data TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),number TEXT,status TEXT NOT NULL,data TEXT NOT NULL,total_cents INTEGER NOT NULL,currency TEXT NOT NULL,issued_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(business_id,number));
  CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES invoices(id),amount_cents INTEGER NOT NULL,date TEXT NOT NULL,method TEXT,reference TEXT,notes TEXT,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES invoices(id),event TEXT NOT NULL,detail TEXT,at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS email_events(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES invoices(id),recipient TEXT NOT NULL,subject TEXT NOT NULL,accepted_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_businesses_user ON businesses(user_id);
  CREATE INDEX IF NOT EXISTS idx_invoices_business ON invoices(business_id);
  CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id);
  CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id);`);

const now=()=>new Date().toISOString(),id=()=>crypto.randomUUID(),text=(value,max=500)=>String(value??'').trim().slice(0,max);
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
function date(value){const s=String(value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||Number.isNaN(Date.parse(s))||new Date(s+'T12:00:00Z').toISOString().slice(0,10)!==s)fail(400,'Enter a valid date.');return s;}
function email(value){const s=text(value,254);if(s&&!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s))fail(400,'Enter a valid email address.');return s;}
function cleanProfile(input){
  const p=plain(input),currency=p.currency||'ZAR';if(!Finance.currencies.includes(currency))fail(400,'Select a supported currency.');
  let website=text(p.website,180);if(website){try{const url=new URL(website);if(!['http:','https:'].includes(url.protocol))throw Error();}catch{fail(400,'Website must be a full http:// or https:// address.');}}
  const prefix=text(p.prefix||`INV-${new Date().getFullYear()}-`,35).replace(/[^A-Za-z0-9_-]/g,'');if(!prefix)fail(400,'Use letters, numbers, hyphens or underscores in the invoice prefix.');
  return {name:text(p.name,120),registration:text(p.registration,80),taxNumber:text(p.taxNumber,80),address:text(p.address,500),email:email(p.email),phone:text(p.phone,80),website,banking:text(p.banking,500),paymentMethods:text(p.paymentMethods,250),currency,terms:text(p.terms,200),notes:text(p.notes,800),instructions:text(p.instructions,800),taxRegistered:!!p.taxRegistered,defaultTaxRate:Finance.rate(p.defaultTaxRate??15),prefix,locale:['en-ZA','en-US','en-GB'].includes(p.locale)?p.locale:'en-ZA'};
}
function cleanCustomer(input){const p=plain(input),name=text(p.name,150);if(!name)fail(400,'Customer name is required.');return {name,email:email(p.email),address:text(p.address,600),registration:text(p.registration,80),taxNumber:text(p.taxNumber,80),phone:text(p.phone,80)};}
function business(user,bid){if(typeof bid!=='string'||!bid)fail(400,'Select a business.');const row=db.prepare('SELECT * FROM businesses WHERE id=? AND user_id=?').get(bid,user);if(!row)fail(404,'Business not found.');return row;}
function invoice(user,iid){const row=db.prepare('SELECT i.* FROM invoices i JOIN businesses b ON b.id=i.business_id WHERE i.id=? AND b.user_id=?').get(iid,user);if(!row)fail(404,'Invoice not found.');return row;}
function activity(iid,event,detail=''){db.prepare('INSERT INTO activities VALUES(?,?,?,?,?)').run(id(),iid,event,detail,now());}
function transaction(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
function send(res,status,body,headers={}){const bytes=Buffer.from(JSON.stringify(body));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Referrer-Policy':'no-referrer',...headers});res.end(bytes);}
async function body(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>6*1024*1024)fail(413,'Request is too large.');chunks.push(chunk);}let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{fail(400,'Invalid JSON.');}if(!result||typeof result!=='object'||Array.isArray(result))fail(400,'Send a JSON object.');return result;}
function checkOrigin(req){if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return;const allowed=[process.env.APP_ORIGIN,`http://localhost:${process.env.PORT||4173}`,`http://127.0.0.1:${process.env.PORT||4173}`].filter(Boolean);if(req.headers.origin&&!allowed.includes(req.headers.origin))fail(403,'Invalid request origin.');if(req.headers['sec-fetch-site']==='cross-site')fail(403,'Cross-site requests are not allowed.');}
function tokenHash(value){return crypto.createHash('sha256').update(value).digest('hex');}
function sessionToken(req){return (req.headers.cookie||'').match(/(?:^|; )session=([^;]+)/)?.[1];}
function auth(req){const token=sessionToken(req);if(!token)fail(401,'Sign in required.');const row=db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash(token),now());if(!row)fail(401,'Your session expired. Please sign in again.');return row.user_id;}
function login(user,res){const token=crypto.randomBytes(32).toString('base64url');db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token),user,new Date(Date.now()+7*86400000).toISOString());send(res,200,{ok:true},{'Set-Cookie':`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.HTTPS==='1'?'; Secure':''}`});}
const attempts=new Map();
function throttle(req,input){const key=(req.socket.remoteAddress||'local')+':'+text(input.email,254).toLowerCase(),time=Date.now(),previous=attempts.get(key);if(previous&&previous.until>time){if(++previous.count>12)fail(429,'Too many attempts. Try again in 15 minutes.');}else attempts.set(key,{count:1,until:time+900000});if(attempts.size>5000){for(const [k,v] of attempts)if(v.until<time)attempts.delete(k);if(attempts.size>5000)attempts.delete(attempts.keys().next().value);}return key;}
const services=createServices({db,dataDir,business,invoice,cleanProfile,cleanCustomer,transaction,send,fail,text,date,activity});

async function api(req,res,url){
  checkOrigin(req);const method=req.method,p=url.pathname.split('/').filter(Boolean),input=['POST','PUT','PATCH'].includes(method)?await body(req):{};
  if(p[1]==='auth'&&method==='POST'&&['register','login'].includes(p[2])){
    const attemptKey=throttle(req,input);const address=email(input.email).toLowerCase(),password=String(input.password||'');if(!address||password.length>256)fail(400,'Enter an email and a password of at most 256 characters.');
    if(p[2]==='register'){if(password.length<12)fail(400,'Use a password of at least 12 characters.');const uid=id(),salt=crypto.randomBytes(16).toString('hex'),hash=crypto.scryptSync(password,salt,64).toString('hex');try{db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(uid,address,salt,hash,now());}catch(error){if(error.code?.includes('CONSTRAINT')||String(error.message).includes('UNIQUE'))fail(409,'Email already registered.');throw error;}return login(uid,res);}
    const user=db.prepare('SELECT * FROM users WHERE email=?').get(address),salt=user?.salt||'00000000000000000000000000000000',hash=crypto.scryptSync(password,salt,64);if(!user||!crypto.timingSafeEqual(hash,Buffer.from(user.hash,'hex')))fail(401,'Invalid email or password.');attempts.delete(attemptKey);return login(user.id,res);
  }
  const user=auth(req);
  if(p[1]==='auth'&&p[2]==='logout'&&method==='POST'){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(sessionToken(req)));return send(res,200,{ok:true},{'Set-Cookie':'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
  if(p[1]==='me'&&method==='GET')return send(res,200,{email:db.prepare('SELECT email FROM users WHERE id=?').get(user).email});
  if(await services.routes(req,res,url,user,input))return;
  if(p[1]==='businesses'&&p.length===2&&method==='GET')return send(res,200,db.prepare('SELECT id,name FROM businesses WHERE user_id=? ORDER BY created_at').all(user));
  if(p[1]==='businesses'&&p[2]&&p[3]==='logo'&&p.length===4){
    const b=business(user,p[2]);if(method==='DELETE'){db.prepare('UPDATE businesses SET logo=NULL,logo_type=NULL WHERE id=?').run(b.id);return send(res,200,{ok:true});}
    if(method==='POST'){const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(input.data||''));if(!match)fail(400,'Choose a PNG or JPG logo.');const bytes=Buffer.from(match[2],'base64');if(bytes.length>2*1024*1024||bytes.length<20)fail(400,'Logo must be under 2 MB.');const signature=match[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217;if(!signature||!imageData(input.data))fail(400,'The image is damaged or uses an unsupported format. Save it as a standard PNG or RGB JPG.');db.prepare('UPDATE businesses SET logo=?,logo_type=? WHERE id=?').run(bytes,`image/${match[1]}`,b.id);return send(res,200,{ok:true});}
  }
  if(['customers','products'].includes(p[1])){
    const table=p[1],b=business(user,url.searchParams.get('businessId')||input.businessId);
    if(table==='customers'&&p.length===2&&method==='POST'){const value=cleanCustomer(input),rid=id();db.prepare('INSERT INTO customers VALUES(?,?,?,0)').run(rid,b.id,JSON.stringify(value));return send(res,201,{id:rid,...value});}
    if(p[2]&&p.length===3){const row=db.prepare(`SELECT id FROM ${table} WHERE id=? AND business_id=?`).get(p[2],b.id);if(!row)fail(404,'Record not found.');if(table==='customers'&&method==='PUT'){const value=cleanCustomer(input);db.prepare('UPDATE customers SET data=? WHERE id=?').run(JSON.stringify(value),row.id);return send(res,200,{id:row.id,...value});}if(method==='DELETE'){db.prepare(`UPDATE ${table} SET archived=1 WHERE id=?`).run(row.id);return send(res,200,{ok:true});}}
  }
  fail(404,'Not found.');
}
const staticFiles=new Set(['index.html','app.js','editor.js','workspace.js','finance.js','document.js','styles.css','enhancements.css']);
const server=http.createServer(async(req,res)=>{
  try{const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/'))return await api(req,res,url);const file=url.pathname==='/'?'index.html':url.pathname.slice(1);if(!staticFiles.has(file)||req.method!=='GET')fail(404,'Not found.');const bytes=fs.readFileSync(path.join(root,'public',file)),type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html';res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(bytes);}
  catch(error){if(!res.headersSent)send(res,error.status||500,{error:error.status?error.message:'Unexpected server error. Please try again.'});else res.end();if(!error.status)console.error('Request failed:',req.method,new URL(req.url,'http://localhost').pathname,error.code||'INTERNAL');}
});
if(require.main===module)server.listen(Number(process.env.PORT)||4173,process.env.HOST||'127.0.0.1',()=>console.log(`Invoice Studio: http://localhost:${process.env.PORT||4173}`));
module.exports={server,db,calculate:Finance.calculate,cleanInvoice:services.normaliseInvoice,invoiceHtml:Document.render};
