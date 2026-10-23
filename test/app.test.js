const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const zlib=require('node:zlib');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-test-'));
const {server,db}=require('../server');
const {drawInvoice}=require('../pdf');

test('account isolation, invoice math, numbering and payments',async()=>{
  await new Promise(resolve=>server.listen(0,resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(route,method='GET',data,cookie=''){
    const r=await fetch(base+'/api'+route,{method,headers:{'content-type':'application/json',cookie},body:data?JSON.stringify(data):undefined});
    const ct=r.headers.get('content-type')||'';
    return {status:r.status,body:ct.includes('json')?await r.json():await r.arrayBuffer(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  try{
    const a=await call('/auth/register','POST',{email:'owner@example.com',password:'strong-password-123'});assert.equal(a.status,200);
    const owner=a.cookie;
    for(let attempt=0;attempt<13;attempt++)assert.equal((await call('/auth/login','POST',{email:'owner@example.com',password:'strong-password-123'})).status,200);
    for(let attempt=0;attempt<12;attempt++)assert.equal((await call('/auth/login','POST',{email:'owner@example.com',password:'wrong-password-123'})).status,401);
    assert.equal((await call('/auth/login','POST',{email:'owner@example.com',password:'wrong-password-123'})).status,429);
    let r=await call('/businesses','POST',{name:'Studio A',currency:'ZAR',prefix:'INV-2026-',taxRegistered:true,defaultTaxRate:15},owner);assert.equal(r.status,201);const bid=r.body.id;
    const pngChunk=(tag,data)=>{const name=Buffer.from(tag),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);let value=0xffffffff;for(const byte of Buffer.concat([name,data])){value^=byte;for(let k=0;k<8;k++)value=(value>>>1)^(value&1?0xedb88320:0)}crc.writeUInt32BE((value^0xffffffff)>>>0);return Buffer.concat([len,name,data,crc])};
    const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',zlib.deflateSync(Buffer.from([0,23,77,70,255]))),pngChunk('IEND',Buffer.alloc(0))]);
    r=await call(`/businesses/${bid}/logo`,'POST',{data:'data:image/png;base64,'+png.toString('base64')},owner);assert.equal(r.status,200);
    r=await call(`/businesses/${bid}`,'GET',null,owner);assert.equal(r.body.logo,'data:image/png;base64,'+png.toString('base64'));
    r=await call(`/businesses/${bid}`,'PUT',{profile:{...r.body.profile,name:'Studio A',currency:'ZAR'},design:{template:'elegant',accent:'#563e56',font:'Georgia',logoAlign:'right',logoWidth:200}},owner);assert.equal(r.status,200);
    r=await call(`/businesses/${bid}`,'GET',null,owner);assert.equal(r.body.design.template,'elegant');assert.equal(r.body.design.logoWidth,200);
    r=await call(`/businesses/${bid}/logo`,'POST',{data:'data:image/png;base64,'+Buffer.from('<script>bad</script>').toString('base64')},owner);assert.equal(r.status,400);
    r=await call('/customers','POST',{businessId:bid,name:'Client One',email:'client@example.com'},owner);assert.equal(r.status,201);const cid=r.body.id;
    r=await call('/products','POST',{businessId:bid,name:'Consulting',price:'100.00',taxRate:15},owner);assert.equal(r.status,201);
    const input={businessId:bid,customerId:cid,customer:{name:'Client One'},issueDate:'2026-01-01',dueDate:'2026-01-10',currency:'ZAR',items:[{description:'Consulting',quantity:2,unitPrice:'100.00',discountRate:10,taxRate:15,taxTreatment:'standard'},{description:'Expenses',quantity:1,unitPrice:'50.00',discountRate:0,taxRate:0,taxTreatment:'zero'}],invoiceDiscountRate:10,shipping:'5.00',shippingTaxRate:0};
    r=await call('/invoices','POST',input,owner);assert.equal(r.status,201);const iid=r.body.id;
    r=await call('/invoices/'+iid,'GET',null,owner);assert.equal(r.body.totalCents,23630);assert.equal(r.body.number,null);assert.equal(r.body.status,'draft');
    r=await call('/invoices/'+iid+'/issue','POST',{},owner);assert.equal(r.body.number,'INV-2026-0001');
    r=await call('/invoices/'+iid,'GET',null,owner);assert.equal(r.body.status,'overdue');
    r=await call('/invoices/'+iid,'PUT',input,owner);assert.equal(r.status,409);
    r=await call('/invoices/'+iid+'/payments','POST',{amount:'100.00',date:'2026-01-05',method:'EFT'},owner);assert.equal(r.status,201);
    r=await call('/invoices/'+iid,'GET',null,owner);assert.equal(r.body.balanceCents,13630);assert.equal(r.body.status,'overdue');
    r=await call('/invoices/'+iid+'/payments','POST',{amount:'136.30',date:'2026-01-06',method:'EFT'},owner);assert.equal(r.status,201);
    r=await call('/invoices/'+iid,'GET',null,owner);assert.equal(r.body.status,'paid');assert.equal(r.body.balanceCents,0);
    r=await call('/invoices/'+iid+'/duplicate','POST',{},owner);assert.equal(r.status,201);
    const copy=r.body.id;r=await call('/invoices/'+copy+'/issue','POST',{},owner);assert.equal(r.body.number,'INV-2026-0002');
    const other=await call('/auth/register','POST',{email:'other@example.com',password:'strong-password-123'});assert.equal(other.status,200);
    r=await call('/invoices/'+iid,'GET',null,other.cookie);assert.equal(r.status,404);
    r=await call('/customers?businessId='+bid,'GET',null,other.cookie);assert.equal(r.status,404);
    r=await call('/invoices/'+iid+'/print','GET',null,owner);assert.equal(r.status,200);assert.match(Buffer.from(r.body).toString(),/data:image\/png;base64/);
    r=await call('/invoices/'+iid+'/pdf','GET',null,owner);assert.equal(r.status,200);assert.equal(Buffer.from(r.body).subarray(0,5).toString(),'%PDF-');assert.match(Buffer.from(r.body).toString('latin1'),/\/Subtype \/Image/);
    r=await call('/invoices/'+iid+'/email','POST',{to:'client@example.com',subject:'Invoice',message:'Please find attached.'},owner);assert.equal(r.status,501);
    r=await call('/invoices/'+iid,'GET',null,owner);assert.equal(r.body.status,'paid');
    r=await call(`/businesses/${bid}/logo`,'DELETE',null,owner);assert.equal(r.status,200);
    r=await call(`/businesses/${bid}`,'GET',null,owner);assert.equal(r.body.logo,null);
  }finally{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true})}
});

test('long PDF repeats table headings and keeps totals on A4 pages',()=>{
  const items=Array.from({length:50},(_,i)=>({description:`Consulting session ${i+1} with a detailed service description`,quantity:1,unitPrice:'100.00',taxableCents:10000,taxCents:1500}));
  const data={businessSnapshot:{name:'Long Invoice Ltd',address:'Johannesburg',locale:'en-ZA',banking:'Example Bank'},design:{template:'corporate',accent:'#203a65',font:'Arial',margin:42,heading:'INVOICE',tableStyle:'striped'},customer:{name:'Customer'},issueDate:'2026-10-01',dueDate:'2026-10-30',items,subtotalCents:500000,lineDiscountCents:0,invoiceDiscountCents:0,taxCents:75000,shippingCents:0};
  const output=drawInvoice({number:'INV-50',currency:'ZAR',totalCents:575000,paidCents:0,balanceCents:575000,data}).toString('latin1');
  const encoded=value=>'<'+Array.from(value,c=>c.codePointAt(0).toString(16).padStart(4,'0')).join('')+'> Tj';
  assert.match(output,/\/MediaBox \[0 0 595\.28 841\.89\]/);
  assert.ok((output.match(/\/Type \/Page \/Parent/g)||[]).length>=2);
  assert.equal(output.split(encoded('Description')).length-1,(output.match(/\/Type \/Page \/Parent/g)||[]).length);
  assert.ok(output.includes(encoded('Balance due')));
});
