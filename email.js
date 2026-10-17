const net=require('node:net');
const tls=require('node:tls');
const crypto=require('node:crypto');

function emailConfiguration(){
  const configured=!!(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASSWORD&&process.env.SMTP_FROM);
  return {configured,help:configured?'Invoices can be sent through your configured email provider.':'Email is not set up yet. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM to .env, then restart the app. PDF downloads and printing are available.'};
}
function address(value){const s=String(value||'').trim();if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)||s.length>254)throw Object.assign(new Error('Enter a valid recipient email address.'),{status:400});return s;}
const encoded=s=>'=?UTF-8?B?'+Buffer.from(String(s||'')).toString('base64')+'?=';
const base64=buffer=>buffer.toString('base64').match(/.{1,76}/g)?.join('\r\n')||'';

function connection(socket){
  let buffer='',lines=[],queue=[],pending=[],ended=false;
  const data=chunk=>{
    buffer+=chunk.toString('utf8');
    while(buffer.includes('\r\n')){
      const at=buffer.indexOf('\r\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+2);lines.push(line);
      if(/^\d{3} /.test(line)){const response={code:Number(line.slice(0,3)),lines};lines=[];const waiter=pending.shift();waiter?waiter.resolve(response):queue.push(response);}
    }
  };
  const terminate=error=>{ended=true;pending.splice(0).forEach(p=>p.reject(error instanceof Error?error:new Error('SMTP connection closed.')));};
  const timeout=()=>{terminate(new Error('SMTP response timed out.'));socket.destroy();};
  socket.on('data',data);socket.on('error',terminate);socket.on('close',terminate);socket.on('timeout',timeout);socket.setTimeout(20000);
  return {
    socket,
    read:()=>queue.length?Promise.resolve(queue.shift()):ended?Promise.reject(new Error('SMTP connection closed.')):new Promise((resolve,reject)=>pending.push({resolve,reject})),
    detach:()=>{socket.removeListener('data',data);socket.removeListener('error',terminate);socket.removeListener('close',terminate);socket.removeListener('timeout',timeout);socket.setTimeout(0);},
  };
}
async function sendInvoice({to,subject,message,pdf,filename}){
  if(!emailConfiguration().configured)throw Object.assign(new Error(emailConfiguration().help),{status:501});
  const host=process.env.SMTP_HOST,port=Number(process.env.SMTP_PORT||465),sender=address(process.env.SMTP_FROM),recipient=address(to);
  if(![465,587].includes(port))throw Object.assign(new Error('Use SMTP port 465 for TLS or port 587 for STARTTLS.'),{status:501});
  let conn=connection(port===465?tls.connect({host,port,servername:host,rejectUnauthorized:true}):net.connect({host,port}));
  async function expect(codes){const r=await conn.read();if(![].concat(codes).includes(r.code))throw new Error('The SMTP provider rejected the request.');return r;}
  async function command(value,codes){conn.socket.write(value+'\r\n');return expect(codes);}
  let accepted=false;
  try{
    await expect(220);let ehlo=await command('EHLO invoice-studio.local',250);
    if(port===587){if(!ehlo.lines.some(s=>/STARTTLS/i.test(s)))throw new Error('The SMTP provider does not offer STARTTLS.');await command('STARTTLS',220);const old=conn.socket;conn.detach();conn=connection(tls.connect({socket:old,servername:host,rejectUnauthorized:true}));await new Promise((resolve,reject)=>{conn.socket.once('secureConnect',resolve);conn.socket.once('error',reject);});ehlo=await command('EHLO invoice-studio.local',250);}
    if(ehlo.lines.some(s=>/AUTH.*PLAIN/i.test(s))){await command('AUTH PLAIN '+Buffer.from(`\0${process.env.SMTP_USER}\0${process.env.SMTP_PASSWORD}`).toString('base64'),235);}
    else{await command('AUTH LOGIN',334);await command(Buffer.from(process.env.SMTP_USER).toString('base64'),334);await command(Buffer.from(process.env.SMTP_PASSWORD).toString('base64'),235);}
    await command(`MAIL FROM:<${sender}>`,250);await command(`RCPT TO:<${recipient}>`,[250,251]);await command('DATA',354);
    const boundary='invoice-'+crypto.randomBytes(12).toString('hex'),safeName=String(filename).replace(/[^a-zA-Z0-9_.-]/g,'_');
    const mime=[`From: <${sender}>`,`To: <${recipient}>`,`Date: ${new Date().toUTCString()}`,`Message-ID: <${crypto.randomUUID()}@invoice-studio.local>`,`Subject: ${encoded(subject)}`,'MIME-Version: 1.0',`Content-Type: multipart/mixed; boundary="${boundary}"`,'',`--${boundary}`,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',base64(Buffer.from(message||'')),`--${boundary}`,`Content-Type: application/pdf; name="${safeName}"`,'Content-Transfer-Encoding: base64',`Content-Disposition: attachment; filename="${safeName}"`,'',base64(pdf),`--${boundary}--`,''].join('\r\n');
    await command(mime.replace(/^\./gm,'..')+'\r\n.',250);accepted=true;
    try{await command('QUIT',221);}catch{}
  }finally{conn.socket.destroy();}
  return {accepted};
}
module.exports={sendInvoice,emailConfiguration};
