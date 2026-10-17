const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const Finance=require('./public/finance');
const Document=require('./public/document');
const {drawInvoice}=require('./pdf');
const {sendInvoice,emailConfiguration}=require('./email');

module.exports=function createServices({db,dataDir,business,invoice,cleanProfile,cleanCustomer,transaction,send,fail,text,date,activity}) {
  const now=()=>new Date().toISOString(),id=()=>crypto.randomUUID(),parse=JSON.parse;
  const migrationTable=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  const version=migrationTable?db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get().version:0;
  if(version<3&&db.prepare('SELECT COUNT(*) AS count FROM users').get().count){const directory=path.join(dataDir,'backups');fs.mkdirSync(directory,{recursive:true});db.prepare('VACUUM INTO ?').run(path.join(directory,'before-upgrade-'+Date.now()+'.sqlite'));}
  const localToday=()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:process.env.APP_TIMEZONE||'Africa/Johannesburg',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
  db.exec(`CREATE TABLE IF NOT EXISTS credit_notes(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES invoices(id),business_id TEXT NOT NULL REFERENCES businesses(id),number TEXT NOT NULL,data TEXT NOT NULL,total_cents INTEGER NOT NULL,date TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(business_id,number));
    CREATE TABLE IF NOT EXISTS refunds(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES invoices(id),amount_cents INTEGER NOT NULL,date TEXT NOT NULL,method TEXT,reference TEXT,notes TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS counters(business_id TEXT NOT NULL REFERENCES businesses(id),kind TEXT NOT NULL,next_number INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(business_id,kind));
    CREATE TABLE IF NOT EXISTS operation_keys(key TEXT PRIMARY KEY,user_id TEXT NOT NULL,operation TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_attempts(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES invoices(id),recipient TEXT NOT NULL,subject TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quotations(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),number TEXT,status TEXT NOT NULL,data TEXT NOT NULL,total_cents INTEGER NOT NULL,currency TEXT NOT NULL,invoice_id TEXT REFERENCES invoices(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(business_id,number));
    CREATE TABLE IF NOT EXISTS quotation_activity(id TEXT PRIMARY KEY,quotation_id TEXT NOT NULL REFERENCES quotations(id),event TEXT NOT NULL,detail TEXT NOT NULL,at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quotation_email(id TEXT PRIMARY KEY,quotation_id TEXT NOT NULL REFERENCES quotations(id),recipient TEXT NOT NULL,subject TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_credits_invoice ON credit_notes(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_invoice ON refunds(invoice_id);`);
  if(version<3)transaction(()=>{
    const records=db.prepare('SELECT p.id,p.data,b.profile FROM products p JOIN businesses b ON b.id=p.business_id').all();
    for(const record of records){const product=parse(record.data);if(!product.currency){product.currency=parse(record.profile).currency||'ZAR';db.prepare('UPDATE products SET data=? WHERE id=?').run(JSON.stringify(product),record.id);}}
    db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(3,?)').run(now());
  });

  function profile(input) {
    const p=cleanProfile(input),days=Number(input.termsDays??14),padding=Number(input.numberPadding??4);
    if(!Number.isInteger(days)||days<0||days>365)fail(400,'Payment term days must be between 0 and 365.');
    if(!Number.isInteger(padding)||padding<1||padding>10)fail(400,'Number padding must be between 1 and 10.');
    const quoteDays=Number(input.quoteDays??30);if(!Number.isInteger(quoteDays)||quoteDays<1||quoteDays>365)fail(400,'Quote validity must be between 1 and 365 days.');
    return {...p,termsDays:days,quoteDays,numberPadding:padding,creditPrefix:text(input.creditPrefix||'CN-',35).replace(/[^A-Za-z0-9_-]/g,'')||'CN-',quotePrefix:text(input.quotePrefix||'QUO-',35).replace(/[^A-Za-z0-9_-]/g,'')||'QUO-'};
  }
  function normaliseInvoice(input,b) {
    const customer=cleanCustomer(input.customer),customerId=text(input.customerId,80),issueDate=date(input.issueDate),dueDate=date(input.dueDate);
    if(dueDate<issueDate)fail(400,'Due date cannot precede issue date.');
    if(customerId&&!db.prepare('SELECT id FROM customers WHERE id=? AND business_id=?').get(customerId,b.id))fail(400,'Customer was not found in this business.');
    const currency=input.currency||parse(b.profile).currency,calculated=Finance.calculate({...input,currency});
    return {...calculated,customer,customerId,issueDate,dueDate,poNumber:text(input.poNumber,80),reference:text(input.reference,80),notes:text(input.notes,1000),instructions:text(input.instructions,1000),currency,design:Document.design(input.design||parse(b.design)),businessSnapshot:profile(parse(b.profile)),logoSnapshot:b.logo?`data:${b.logo_type};base64,${Buffer.from(b.logo).toString('base64')}`:null};
  }
  function ledger(row) {
    const payments=db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY date DESC,created_at DESC').all(row.id);
    const refunds=db.prepare('SELECT * FROM refunds WHERE invoice_id=? ORDER BY date DESC,created_at DESC').all(row.id);
    const credits=db.prepare('SELECT * FROM credit_notes WHERE invoice_id=? ORDER BY created_at DESC').all(row.id).map(x=>({...x,data:parse(x.data)}));
    const receivedCents=payments.reduce((n,x)=>n+x.amount_cents,0),refundedCents=refunds.reduce((n,x)=>n+x.amount_cents,0),creditedCents=credits.reduce((n,x)=>n+x.total_cents,0);
    const paidCents=receivedCents-refundedCents,netCents=row.status==='cancelled'?0:row.total_cents-creditedCents,balanceCents=Math.max(0,netCents-paidCents),refundDueCents=Math.max(0,paidCents-netCents),data=parse(row.data);
    let status=row.status;
    if(!['draft','cancelled'].includes(status))status=netCents===0?'credited':balanceCents===0?'paid':data.dueDate<localToday()?'overdue':paidCents>0?'partially-paid':status;
    return {id:row.id,businessId:row.business_id,number:row.number,status,data,totalCents:row.total_cents,currency:row.currency,receivedCents,refundedCents,creditedCents,netCents,paidCents,balanceCents,refundDueCents,payments,refunds,credits,issuedAt:row.issued_at,createdAt:row.created_at,updatedAt:row.updated_at};
  }
  function rowsFor(bid) {return db.prepare('SELECT * FROM invoices WHERE business_id=? ORDER BY created_at DESC').all(bid).map(ledger);}
  function filterRows(rows,params) {
    const q=text(params.get('q'),120).toLowerCase(),customerId=text(params.get('customerId'),80),status=text(params.get('status'),30),currency=text(params.get('currency'),3),from=params.get('from'),to=params.get('to');
    if(currency&&!Finance.currencies.includes(currency))fail(400,'Select a supported currency.');if(from)date(from);if(to)date(to);if(from&&to&&from>to)fail(400,'Start date must precede end date.');
    return rows.filter(x=>(!q||`${x.number||''} ${x.data.customer.name} ${x.data.reference||''}`.toLowerCase().includes(q))&&(!customerId||x.data.customerId===customerId)&&(!status||x.status===status)&&(!currency||x.currency===currency)&&(!from||x.data.issueDate>=from)&&(!to||x.data.issueDate<=to));
  }
  function once(user,operation,key,work) {
    return transaction(()=>{
      const token=text(key,80),prior=token&&db.prepare('SELECT * FROM operation_keys WHERE key=?').get(token);
      if(prior){if(prior.user_id!==user||prior.operation!==operation)fail(409,'This operation identifier was already used.');return parse(prior.result);}
      const result=work();
      if(token)db.prepare('INSERT INTO operation_keys VALUES(?,?,?,?,?)').run(token,user,operation,JSON.stringify(result),now());
      return result;
    });
  }
  function outputDocument(res,record,kind) {
    if(kind==='pdf') {const bytes=drawInvoice(record);res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':bytes.length,'Content-Disposition':`attachment; filename="${String(record.number||'draft').replace(/[^A-Za-z0-9_-]/g,'_')}.pdf"`,'Cache-Control':'no-store'});res.end(bytes);}
    else {let html=Document.render(record);if(kind==='print')html=html.replace("script-src 'none'","script-src 'unsafe-inline'").replace('</body>','<script>window.addEventListener("load",()=>window.print())</script></body>');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(html);}
  }
  function creditRecord(row,original) {
    const d=parse(row.data);
    return {kind:'credit',id:row.id,number:row.number,originalNumber:original.number,reason:row.reason,currency:original.currency,totalCents:row.total_cents,paidCents:0,balanceCents:0,data:d};
  }
  function quote(user,qid){const row=db.prepare('SELECT q.* FROM quotations q JOIN businesses b ON b.id=q.business_id WHERE q.id=? AND b.user_id=?').get(qid,user);if(!row)fail(404,'Quotation not found.');return row;}
  function quoteDisplay(row){const data=parse(row.data);return {id:row.id,businessId:row.business_id,number:row.number,kind:'quotation',status:['issued','sent'].includes(row.status)&&data.dueDate<localToday()?'expired':row.status,data,totalCents:row.total_cents,currency:row.currency,invoiceId:row.invoice_id,createdAt:row.created_at,updatedAt:row.updated_at,paidCents:0,balanceCents:0};}
  function quoteActivity(qid,event,detail=''){db.prepare('INSERT INTO quotation_activity VALUES(?,?,?,?,?)').run(id(),qid,event,detail,now());}
  function createCredit(original,input,user) {
    return once(user,`credit:${original.id}`,input.requestId,()=>{
      const source=invoice(user,original.id),current=ledger(source);
      if(['draft','cancelled'].includes(source.status))fail(409,'Credit notes require an issued invoice.');
      const reason=text(input.reason,500);if(!reason)fail(400,'Enter a credit note reason.');const creditDate=date(input.date);if(creditDate<current.data.issueDate||creditDate>localToday())fail(400,'Credit date must be between the invoice issue date and today.');
      if(!Array.isArray(input.lines)||!input.lines.length)fail(400,'Enter a credit amount against at least one item.');
      const used=new Map();current.credits.forEach(c=>c.data.items.forEach(x=>{const item=used.get(x.sourceIndex)||{base:0,tax:0};item.base+=x.taxableCents;item.tax+=x.taxCents;used.set(x.sourceIndex,item);}));
      const seen=new Set(),items=[];
      input.lines.forEach(selection=>{
        const index=Number(selection.index);if(!Number.isInteger(index)||index< -1||index>=current.data.items.length||seen.has(index))fail(400,'Select each original invoice item only once.');seen.add(index);
        const sourceItem=index===-1?{description:'Shipping / charges',taxableCents:current.data.shippingCents,taxCents:current.data.shippingTaxCents||0,taxRate:current.data.shippingTaxRate||0,taxTreatment:'standard'}:current.data.items[index];
        const consumed=used.get(index)||{base:0,tax:0},base=sourceItem.taxableCents-consumed.base,tax=sourceItem.taxCents-consumed.tax,total=base+tax;
        const requested=Finance.money(selection.amount,current.currency);if(!requested)return;if(requested>total)fail(400,'Credit exceeds the remaining amount on an original item.');
        const [baseCredit,taxCredit]=Finance.allocate(requested,[base,tax],Finance.quantum(current.currency));
        items.push({description:sourceItem.description,sourceIndex:index,sku:sourceItem.sku||'',unit:sourceItem.unit||'each',quantity:1,unitPrice:(baseCredit/100).toFixed(2),discountRate:0,taxRate:sourceItem.taxRate,taxTreatment:sourceItem.taxTreatment,grossCents:baseCredit,discountCents:0,netCents:baseCredit,taxableCents:baseCredit,taxCents:taxCredit});
      });
      if(!items.length)fail(400,'Credit amount must be positive.');
      const total=items.reduce((n,x)=>n+x.taxableCents+x.taxCents,0);if(total>current.totalCents-current.creditedCents)fail(400,'Credit exceeds the uncredited invoice value.');
      const b=business(user,source.business_id),p=profile(parse(b.profile));db.prepare("INSERT OR IGNORE INTO counters VALUES(?,'credit',1)").run(b.id);
      let next=db.prepare("SELECT next_number FROM counters WHERE business_id=? AND kind='credit'").get(b.id).next_number,number;
      do{number=p.creditPrefix+String(next++).padStart(p.numberPadding,'0')}while(db.prepare('SELECT id FROM credit_notes WHERE business_id=? AND number=?').get(b.id,number));
      db.prepare("UPDATE counters SET next_number=? WHERE business_id=? AND kind='credit'").run(next,b.id);
      const cid=id(),data={...current.data,items,issueDate:creditDate,dueDate:creditDate,reference:current.number,notes:reason,instructions:'This credit note reduces the amount charged on the referenced invoice.',design:{...current.data.design,heading:'CREDIT NOTE'},subtotalCents:items.reduce((n,x)=>n+x.taxableCents,0),taxCents:items.reduce((n,x)=>n+x.taxCents,0),lineDiscountCents:0,invoiceDiscountCents:0,shippingCents:0,shippingTaxCents:0,totalCents:total};
      db.prepare('INSERT INTO credit_notes VALUES(?,?,?,?,?,?,?,?,?)').run(cid,source.id,b.id,number,JSON.stringify(data),total,creditDate,reason,now());activity(source.id,'credit note issued',`${number}: ${(total/100).toFixed(2)} ${current.currency}. ${reason}`);return {id:cid,number};
    });
  }

  async function routes(req,res,url,user,input) {
    const p=url.pathname.split('/').filter(Boolean),method=req.method;
    if(p[1]==='capabilities'&&method==='GET'){send(res,200,{email:emailConfiguration(),today:localToday()});return true;}
    if(['customers','products'].includes(p[1])){
      const table=p[1],b=business(user,url.searchParams.get('businessId')||input.businessId);
      if(p.length===2&&method==='GET'){const q=text(url.searchParams.get('q'),120).toLowerCase(),archived=url.searchParams.get('includeArchived')==='1';const records=db.prepare(`SELECT id,data,archived FROM ${table} WHERE business_id=? ORDER BY rowid DESC`).all(b.id).filter(x=>archived||!x.archived).map(x=>({id:x.id,archived:!!x.archived,...parse(x.data)}));send(res,200,records.filter(x=>!q||JSON.stringify(x).toLowerCase().includes(q)));return true;}
      if(p[2]&&p[3]==='restore'&&method==='POST'){const result=db.prepare(`UPDATE ${table} SET archived=0 WHERE id=? AND business_id=?`).run(p[2],b.id);if(!result.changes)fail(404,'Record not found.');send(res,200,{ok:true});return true;}
      if(table==='products'&&((p.length===2&&method==='POST')||(p.length===3&&method==='PUT'))){const name=text(input.name,150),currency=input.currency||parse(b.profile).currency;if(!name)fail(400,'Item name is required.');if(!Finance.currencies.includes(currency))fail(400,'Select a supported currency.');const value={name,description:text(input.description,500),sku:text(input.sku,80),priceCents:Finance.money(input.price,currency),currency,taxRate:Finance.rate(input.taxRate),taxTreatment:['standard','zero','exempt','non-taxable'].includes(input.taxTreatment)?input.taxTreatment:'standard',unit:text(input.unit||'each',40)};if(method==='POST'){const rid=id();db.prepare('INSERT INTO products VALUES(?,?,?,0)').run(rid,b.id,JSON.stringify(value));send(res,201,{id:rid,...value});}else{const result=db.prepare('UPDATE products SET data=? WHERE id=? AND business_id=?').run(JSON.stringify(value),p[2],b.id);if(!result.changes)fail(404,'Record not found.');send(res,200,{id:p[2],...value});}return true;}
    }
    if(p[1]==='businesses'&&p.length===2&&method==='POST'){const value=profile(input);if(!value.name)fail(400,'Business name is required.');const bid=id();db.prepare('INSERT INTO businesses(id,user_id,name,profile,design,created_at) VALUES(?,?,?,?,?,?)').run(bid,user,value.name,JSON.stringify(value),JSON.stringify(Document.defaults),now());send(res,201,{id:bid});return true;}
    if(p[1]==='businesses'&&p[2]&&p.length===3&&method==='GET'){const b=business(user,p[2]);send(res,200,{id:b.id,profile:profile(parse(b.profile)),design:Document.design(parse(b.design)),nextNumber:b.next_number,logo:b.logo?`data:${b.logo_type};base64,${Buffer.from(b.logo).toString('base64')}`:null});return true;}
    if(p[1]==='quotations'&&p.length===2&&method==='GET'){
      const b=business(user,url.searchParams.get('businessId')),rows=filterRows(db.prepare('SELECT * FROM quotations WHERE business_id=? ORDER BY created_at DESC').all(b.id).map(quoteDisplay),url.searchParams),sort=url.searchParams.get('sort')||'newest';
      const sorter={newest:(a,b)=>b.createdAt.localeCompare(a.createdAt),oldest:(a,b)=>a.createdAt.localeCompare(b.createdAt),due:(a,b)=>a.data.dueDate.localeCompare(b.data.dueDate),customer:(a,b)=>a.data.customer.name.localeCompare(b.data.customer.name),total:(a,b)=>b.totalCents-a.totalCents};rows.sort(sorter[sort]||sorter.newest);const pages=Math.max(1,Math.ceil(rows.length/20)),page=Math.min(pages,Math.max(1,Math.floor(Number(url.searchParams.get('page'))||1)));send(res,200,{total:rows.length,page,pages,items:rows.slice((page-1)*20,page*20)});return true;
    }
    if(p[1]==='quotations'&&p.length===2&&method==='POST'){
      const b=business(user,input.businessId),data=normaliseInvoice(input,b),result=once(user,`create-quotation:${b.id}`,input.requestId,()=>{const qid=id(),t=now();db.prepare('INSERT INTO quotations VALUES(?,?,?,?,?,?,?,?,?,?)').run(qid,b.id,null,'draft',JSON.stringify(data),data.totalCents,data.currency,null,t,t);quoteActivity(qid,'created','Quotation draft created');return {id:qid};});send(res,201,result);return true;
    }
    if(p[1]==='quotations'&&p[2]){
      const row=quote(user,p[2]);
      if(p.length===3&&method==='GET'){send(res,200,{...quoteDisplay(row),activity:db.prepare('SELECT event,detail,at FROM quotation_activity WHERE quotation_id=? ORDER BY at DESC').all(row.id),emails:db.prepare('SELECT recipient,subject,status,detail,at FROM quotation_email WHERE quotation_id=? ORDER BY at DESC').all(row.id)});return true;}
      if(p.length===3&&method==='PUT'){if(row.status!=='draft')fail(409,'Issued quotations are locked. Duplicate the quotation to revise it.');const data=normaliseInvoice(input,business(user,row.business_id));transaction(()=>{if(quote(user,row.id).status!=='draft')fail(409,'This quotation has already been issued. Duplicate it to make a revision.');db.prepare('UPDATE quotations SET data=?,total_cents=?,currency=?,updated_at=? WHERE id=?').run(JSON.stringify(data),data.totalCents,data.currency,now(),row.id);quoteActivity(row.id,'edited','Draft updated');});send(res,200,{ok:true});return true;}
      if(p[3]==='issue'&&method==='POST'){const result=transaction(()=>{const current=quote(user,row.id);if(current.status!=='draft')return {number:current.number};const b=business(user,row.business_id),settings=profile(parse(b.profile));db.prepare("INSERT OR IGNORE INTO counters VALUES(?,'quote',1)").run(b.id);let next=db.prepare("SELECT next_number FROM counters WHERE business_id=? AND kind='quote'").get(b.id).next_number,number;do{number=settings.quotePrefix+String(next++).padStart(settings.numberPadding,'0')}while(db.prepare('SELECT id FROM quotations WHERE business_id=? AND number=?').get(b.id,number));db.prepare("UPDATE counters SET next_number=? WHERE business_id=? AND kind='quote'").run(next,b.id);db.prepare("UPDATE quotations SET status='issued',number=?,updated_at=? WHERE id=?").run(number,now(),row.id);quoteActivity(row.id,'issued',number);return {number};});send(res,200,result);return true;}
      if(p[3]==='status'&&method==='POST'){
        const status=input.status;if(!['accepted','declined','cancelled'].includes(status))fail(400,'Select a valid quotation status.');
        transaction(()=>{const current=quote(user,row.id);if(current.invoice_id||['draft','cancelled','declined'].includes(current.status))fail(409,'This quotation cannot change status.');if(status==='accepted'&&quoteDisplay(current).status==='expired')fail(409,'This quotation has expired. Duplicate it to create a renewed quotation.');db.prepare('UPDATE quotations SET status=?,updated_at=? WHERE id=?').run(status,now(),row.id);quoteActivity(row.id,status,text(input.notes,500));});
        send(res,200,{ok:true});return true;
      }
      if(p[3]==='shared'&&method==='POST'){if(['draft','cancelled','declined','expired'].includes(quoteDisplay(row).status))fail(409,'Use an issued, valid quotation to record sharing.');const method=text(input.method,80);if(!method)fail(400,'Enter how the quotation was shared.');transaction(()=>{db.prepare("UPDATE quotations SET status=CASE WHEN status='issued' THEN 'sent' ELSE status END,updated_at=? WHERE id=?").run(now(),row.id);quoteActivity(row.id,'shared manually',`${method}. ${text(input.notes,500)}`);});send(res,200,{ok:true});return true;}
      if(p[3]==='duplicate'&&method==='POST'){const b=business(user,row.business_id),settings=profile(parse(b.profile)),source=parse(row.data),valid=new Date(localToday()+'T12:00:00Z');valid.setUTCDate(valid.getUTCDate()+settings.quoteDays);const data=normaliseInvoice({...source,shipping:(source.shippingCents/100).toFixed(2),issueDate:localToday(),dueDate:valid.toISOString().slice(0,10)},b);const result=once(user,`duplicate-quote:${row.id}`,input.requestId,()=>{const qid=id(),t=now();db.prepare('INSERT INTO quotations VALUES(?,?,?,?,?,?,?,?,?,?)').run(qid,b.id,null,'draft',JSON.stringify(data),data.totalCents,data.currency,null,t,t);quoteActivity(qid,'created',`Duplicated from ${row.number||'draft'}`);return {id:qid};});send(res,201,result);return true;}
      if(p[3]==='convert'&&method==='POST'){const result=transaction(()=>{const source=quote(user,row.id);if(source.invoice_id)return {id:source.invoice_id};if(source.status!=='accepted')fail(409,'Accept the quotation before converting it.');const data=parse(source.data),settings=profile(parse(business(user,row.business_id).profile)),due=new Date(localToday()+'T12:00:00Z');due.setUTCDate(due.getUTCDate()+settings.termsDays);data.issueDate=localToday();data.dueDate=due.toISOString().slice(0,10);data.reference=source.number;data.design={...data.design,heading:'INVOICE'};const iid=id(),t=now();db.prepare('INSERT INTO invoices VALUES(?,?,?,?,?,?,?,?,?,?)').run(iid,row.business_id,null,'draft',JSON.stringify(data),source.total_cents,source.currency,null,t,t);db.prepare("UPDATE quotations SET invoice_id=?,status='converted',updated_at=? WHERE id=?").run(iid,t,row.id);activity(iid,'created',`Converted from quotation ${source.number}`);quoteActivity(row.id,'converted','Invoice draft created');return {id:iid};});send(res,201,result);return true;}
      if(p[3]==='email'&&method==='POST'){if(['draft','cancelled','declined','expired'].includes(quoteDisplay(row).status))fail(409,'Use an issued, valid quotation when sending email.');const to=text(input.to,254),subject=text(input.subject||`Quotation ${row.number}`,180);try{await sendInvoice({to,subject,message:text(input.message,5000),pdf:drawInvoice(quoteDisplay(row)),filename:row.number.replace(/[^A-Za-z0-9_-]/g,'_')+'.pdf'});}catch(e){const detail=e.status?e.message:'The email provider did not accept this message.';db.prepare('INSERT INTO quotation_email VALUES(?,?,?,?,?,?,?)').run(id(),row.id,to,subject,'failed',detail,now());quoteActivity(row.id,'email failed',detail);fail(e.status||502,detail);}transaction(()=>{db.prepare('INSERT INTO quotation_email VALUES(?,?,?,?,?,?,?)').run(id(),row.id,to,subject,'accepted','Accepted by SMTP provider; inbox delivery is not confirmed.',now());db.prepare("UPDATE quotations SET status=CASE WHEN status='issued' THEN 'sent' ELSE status END,updated_at=? WHERE id=?").run(now(),row.id);quoteActivity(row.id,'email accepted',`SMTP provider accepted the message to ${to}`);});send(res,200,{accepted:true,message:'The SMTP provider accepted the message.'});return true;}
      if(['pdf','print','preview'].includes(p[3])&&method==='GET'){outputDocument(res,quoteDisplay(row),p[3]);return true;}
    }
    if(p[1]==='businesses'&&p[2]&&p.length===3&&method==='PUT'){
      const b=business(user,p[2]),value=profile(input.profile||{}),design=Document.design(input.design||parse(b.design));if(!value.name)fail(400,'Business name is required.');
      transaction(()=>{const current=business(user,b.id),next=Number(input.nextNumber??current.next_number);if(!Number.isSafeInteger(next)||next<current.next_number||next>1000000000)fail(400,`Next number must be an integer from ${current.next_number} to 1,000,000,000. Issued numbers cannot be reused.`);db.prepare('UPDATE businesses SET name=?,profile=?,design=?,next_number=? WHERE id=?').run(value.name,JSON.stringify(value),JSON.stringify(design),next,b.id);});send(res,200,{ok:true});return true;
    }
    if(p[1]==='invoices'&&p.length===2&&method==='GET'){
      const b=business(user,url.searchParams.get('businessId')),rows=filterRows(rowsFor(b.id),url.searchParams),sort=url.searchParams.get('sort')||'newest';
      const sorts={newest:(a,b)=>b.createdAt.localeCompare(a.createdAt),oldest:(a,b)=>a.createdAt.localeCompare(b.createdAt),due:(a,b)=>a.data.dueDate.localeCompare(b.data.dueDate),customer:(a,b)=>a.data.customer.name.localeCompare(b.data.customer.name),total:(a,b)=>b.totalCents-a.totalCents,balance:(a,b)=>b.balanceCents-a.balanceCents};rows.sort(sorts[sort]||sorts.newest);
      const pageSize=20,pages=Math.max(1,Math.ceil(rows.length/pageSize)),page=Math.min(pages,Math.max(1,Math.floor(Number(url.searchParams.get('page'))||1)));send(res,200,{total:rows.length,page,pages,items:rows.slice((page-1)*pageSize,page*pageSize)});return true;
    }
    if(p[1]==='invoices'&&p.length===2&&method==='POST'){
      const b=business(user,input.businessId),data=normaliseInvoice(input,b),result=once(user,`create-invoice:${b.id}`,input.requestId,()=>{const iid=id(),t=now();db.prepare('INSERT INTO invoices VALUES(?,?,?,?,?,?,?,?,?,?)').run(iid,b.id,null,'draft',JSON.stringify(data),data.totalCents,data.currency,null,t,t);activity(iid,'created','Draft created');return {id:iid};});send(res,201,result);return true;
    }
    if(p[1]==='invoices'&&p[2]){
      const row=invoice(user,p[2]);
      if(p.length===3&&method==='GET'){send(res,200,{...ledger(row),activity:db.prepare('SELECT event,detail,at FROM activities WHERE invoice_id=? ORDER BY at DESC').all(row.id),emails:[...db.prepare('SELECT recipient,subject,status,detail,at FROM email_attempts WHERE invoice_id=?').all(row.id),...db.prepare("SELECT recipient,subject,'accepted' AS status,'Accepted by SMTP provider' AS detail,accepted_at AS at FROM email_events WHERE invoice_id=?").all(row.id)].sort((a,b)=>b.at.localeCompare(a.at))});return true;}
      if(p.length===3&&method==='PUT'){if(row.status!=='draft')fail(409,'Issued invoices are locked. Issue a credit note or duplicate the invoice to correct it.');const data=normaliseInvoice(input,business(user,row.business_id));transaction(()=>{if(invoice(user,row.id).status!=='draft')fail(409,'This invoice has already been issued. Use a credit note or duplicate it.');db.prepare('UPDATE invoices SET data=?,total_cents=?,currency=?,updated_at=? WHERE id=?').run(JSON.stringify(data),data.totalCents,data.currency,now(),row.id);activity(row.id,'edited','Draft updated');});send(res,200,{ok:true});return true;}
      if(p[3]==='issue'&&method==='POST'){
        const result=transaction(()=>{const current=invoice(user,row.id);if(current.status!=='draft')return {number:current.number};const b=business(user,row.business_id),settings=profile(parse(b.profile));let next=b.next_number,number;do{number=settings.prefix+String(next++).padStart(settings.numberPadding,'0')}while(db.prepare('SELECT id FROM invoices WHERE business_id=? AND number=?').get(b.id,number));db.prepare('UPDATE businesses SET next_number=? WHERE id=?').run(next,b.id);db.prepare("UPDATE invoices SET number=?,status='issued',issued_at=?,updated_at=? WHERE id=?").run(number,now(),now(),row.id);activity(row.id,'issued',number);return {number};});send(res,200,result);return true;
      }
      if(p[3]==='duplicate'&&method==='POST'){const source=parse(row.data),b=business(user,row.business_id),p=profile(parse(b.profile)),due=new Date(localToday()+'T12:00:00Z');due.setUTCDate(due.getUTCDate()+p.termsDays);const data=normaliseInvoice({...source,shipping:(source.shippingCents/100).toFixed(2),issueDate:localToday(),dueDate:due.toISOString().slice(0,10)},b);const result=once(user,`duplicate:${row.id}`,input.requestId,()=>{const iid=id(),t=now();db.prepare('INSERT INTO invoices VALUES(?,?,?,?,?,?,?,?,?,?)').run(iid,b.id,null,'draft',JSON.stringify(data),data.totalCents,data.currency,null,t,t);activity(iid,'created',`Duplicated from ${row.number||'draft'}`);return {id:iid};});send(res,201,result);return true;}
      if(p[3]==='cancel'&&method==='POST'){transaction(()=>{const current=ledger(invoice(user,row.id));if(['draft','cancelled'].includes(current.status))fail(409,'Only issued invoices can be cancelled.');if(current.payments.length||current.credits.length)fail(409,'This invoice has financial records. Use a credit note and record any refund.');const reason=text(input.reason,500);if(!reason)fail(400,'Enter a cancellation reason.');db.prepare("UPDATE invoices SET status='cancelled',updated_at=? WHERE id=?").run(now(),row.id);activity(row.id,'cancelled',reason);});send(res,200,{ok:true});return true;}
      if(p[3]==='payments'&&method==='POST'){
        const result=once(user,`payment:${row.id}`,input.requestId,()=>{const current=ledger(invoice(user,row.id));if(['draft','cancelled'].includes(current.status))fail(409,'Issue this invoice before recording payments.');const value=Finance.money(input.amount,row.currency),paymentDate=date(input.date);if(paymentDate<current.data.issueDate||paymentDate>localToday())fail(400,'Payment date must be between the issue date and today.');if(value<=0||value>current.balanceCents)fail(400,'Payment must be positive and no greater than the outstanding balance.');const pid=id();db.prepare('INSERT INTO payments VALUES(?,?,?,?,?,?,?,?)').run(pid,row.id,value,paymentDate,text(input.method,80),text(input.reference,120),text(input.notes,500),now());activity(row.id,'payment',`${(value/100).toFixed(2)} ${row.currency}`);return {id:pid};});send(res,201,result);return true;
      }
      if(p[3]==='credits'&&method==='POST'){send(res,201,createCredit(row,input,user));return true;}
      if(p[3]==='shared'&&method==='POST'){if(['draft','cancelled'].includes(row.status))fail(409,'Issue the invoice before recording sharing.');const method=text(input.method,80);if(!method)fail(400,'Enter how the invoice was shared.');transaction(()=>{db.prepare("UPDATE invoices SET status=CASE WHEN status='issued' THEN 'sent' ELSE status END,updated_at=? WHERE id=?").run(now(),row.id);activity(row.id,'shared manually',`${method}. ${text(input.notes,500)}`);});send(res,200,{ok:true});return true;}
      if(p[3]==='refunds'&&method==='POST'){
        const result=once(user,`refund:${row.id}`,input.requestId,()=>{const current=ledger(invoice(user,row.id)),value=Finance.money(input.amount,row.currency),refundDate=date(input.date);if(value<=0||value>current.refundDueCents)fail(400,'Refund must be positive and no greater than the refund due.');if(refundDate<current.data.issueDate||refundDate>localToday())fail(400,'Use a refund date between the issue date and today.');const rid=id();db.prepare('INSERT INTO refunds VALUES(?,?,?,?,?,?,?,?)').run(rid,row.id,value,refundDate,text(input.method,80),text(input.reference,120),text(input.notes,500),now());activity(row.id,'refund recorded',`${(value/100).toFixed(2)} ${row.currency}`);return {id:rid};});send(res,201,result);return true;
      }
      if(p[3]==='email'&&method==='POST'){
        if(['draft','cancelled'].includes(row.status))fail(409,'Issue the invoice before sending it.');const to=text(input.to,254),subject=text(input.subject||`Invoice ${row.number}`,180),message=text(input.message,5000);
        try{await sendInvoice({to,subject,message,pdf:drawInvoice(ledger(row)),filename:row.number.replace(/[^A-Za-z0-9_-]/g,'_')+'.pdf'});}catch(e){const detail=e.status===501?e.message:'Email was not accepted by the configured SMTP provider.';db.prepare('INSERT INTO email_attempts VALUES(?,?,?,?,?,?,?)').run(id(),row.id,to,subject,'failed',detail,now());activity(row.id,'email failed',detail);fail(e.status||502,detail);}
        transaction(()=>{db.prepare('INSERT INTO email_attempts VALUES(?,?,?,?,?,?,?)').run(id(),row.id,to,subject,'accepted','Accepted by SMTP provider; inbox delivery is not confirmed.',now());db.prepare("UPDATE invoices SET status=CASE WHEN status='issued' THEN 'sent' ELSE status END,updated_at=? WHERE id=?").run(now(),row.id);activity(row.id,'email accepted',`SMTP provider accepted the message to ${to}`);});send(res,200,{accepted:true,message:'The SMTP provider accepted the message.'});return true;
      }
      if(['pdf','print','preview'].includes(p[3])&&method==='GET'){outputDocument(res,ledger(row),p[3]);return true;}
    }
    if(p[1]==='credits'&&p[2]&&['pdf','print','preview'].includes(p[3])&&method==='GET'){
      const credit=db.prepare('SELECT c.* FROM credit_notes c JOIN businesses b ON b.id=c.business_id WHERE c.id=? AND b.user_id=?').get(p[2],user);if(!credit)fail(404,'Credit note not found.');outputDocument(res,creditRecord(credit,invoice(user,credit.invoice_id)),p[3]);return true;
    }
    if(p[1]==='report'&&method==='GET'){
      const b=business(user,url.searchParams.get('businessId')),all=rowsFor(b.id),params=new URLSearchParams(url.searchParams);if(!params.get('currency'))params.set('currency',parse(b.profile).currency);
      const rows=filterRows(all,params),active=rows.filter(x=>!['draft','cancelled'].includes(x.status)),sum=key=>active.reduce((n,x)=>n+x[key],0),today=localToday();
      const recent=rows.slice(0,5),upcoming=active.filter(x=>x.balanceCents>0&&x.data.dueDate>=today).sort((a,b)=>a.data.dueDate.localeCompare(b.data.dueDate)).slice(0,8);
      const payments=active.flatMap(x=>x.payments.map(p=>({...p,invoiceId:x.id,number:x.number,currency:x.currency}))).filter(p=>(!params.get('from')||p.date>=params.get('from'))&&(!params.get('to')||p.date<=params.get('to'))).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,8);
      send(res,200,{issued:active.length,invoicedCents:sum('totalCents'),creditedCents:sum('creditedCents'),netCents:sum('netCents'),paidCents:sum('paidCents'),outstandingCents:sum('balanceCents'),refundDueCents:sum('refundDueCents'),overdue:active.filter(x=>x.status==='overdue').length,currency:params.get('currency'),currencies:[...new Set(all.map(x=>x.currency).concat(parse(b.profile).currency))],recent,upcoming,payments});return true;
    }
    if(p[1]==='export'&&method==='GET'){
      const b=business(user,url.searchParams.get('businessId')),quotation=url.searchParams.get('kind')==='quotations',records=quotation?db.prepare('SELECT * FROM quotations WHERE business_id=? ORDER BY created_at DESC').all(b.id).map(quoteDisplay):rowsFor(b.id),rows=filterRows(records,url.searchParams),cell=v=>'"'+(/^[=+@-]/.test(String(v))?"'"+String(v):String(v)).replaceAll('"','""')+'"';
      const csv=[quotation?'Number,Status,Customer,Issue Date,Valid Until,Currency,Total':'Number,Status,Customer,Issue Date,Due Date,Currency,Gross,Credits,Net,Payments less refunds,Outstanding,Refund due',...rows.map(x=>[x.number||'',x.status,x.data.customer.name,x.data.issueDate,x.data.dueDate,x.currency,...(quotation?[x.totalCents]:[x.totalCents,x.creditedCents,x.netCents,x.paidCents,x.balanceCents,x.refundDueCents]).map(n=>(n/100).toFixed(2))].map(cell).join(','))].join('\r\n');res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${quotation?'quotations':'invoices'}.csv"`,'Cache-Control':'no-store'});res.end('\ufeff'+csv);return true;
    }
    if(p[1]==='backup'&&method==='GET'){
      const payload=transaction(()=>({
        version:3,exportedAt:now(),email:db.prepare('SELECT email FROM users WHERE id=?').get(user).email,
        businesses:db.prepare('SELECT * FROM businesses WHERE user_id=?').all(user).map(b=>({
          id:b.id,profile:profile(parse(b.profile)),design:Document.design(parse(b.design)),nextNumber:b.next_number,
          logo:b.logo?`data:${b.logo_type};base64,${Buffer.from(b.logo).toString('base64')}`:null,
          counters:db.prepare('SELECT kind,next_number FROM counters WHERE business_id=?').all(b.id),
          customers:db.prepare('SELECT id,data,archived FROM customers WHERE business_id=?').all(b.id).map(x=>({...x,data:parse(x.data)})),
          products:db.prepare('SELECT id,data,archived FROM products WHERE business_id=?').all(b.id).map(x=>({...x,data:parse(x.data)})),
          quotations:db.prepare('SELECT * FROM quotations WHERE business_id=?').all(b.id).map(row=>({...quoteDisplay(row),activity:db.prepare('SELECT event,detail,at FROM quotation_activity WHERE quotation_id=?').all(row.id),emails:db.prepare('SELECT recipient,subject,status,detail,at FROM quotation_email WHERE quotation_id=?').all(row.id)})),
          invoices:rowsFor(b.id).map(x=>({...x,activity:db.prepare('SELECT event,detail,at FROM activities WHERE invoice_id=?').all(x.id),emails:[...db.prepare('SELECT recipient,subject,status,detail,at FROM email_attempts WHERE invoice_id=?').all(x.id),...db.prepare("SELECT recipient,subject,'accepted' AS status,accepted_at AS at FROM email_events WHERE invoice_id=?").all(x.id)]}))
        }))
      }));
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="invoice-studio-records-${localToday()}.json"`,'Cache-Control':'no-store'});res.end(JSON.stringify(payload,null,2));return true;
    }
    return false;
  }
  return {routes,normaliseInvoice,ledger,profile};
};
