const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
const state={me:null,businesses:[],business:null,capabilities:null,page:'dashboard',customers:[],products:[],editor:null,editing:null,kind:'invoices',tab:'details',baseline:null,register:false,filters:{invoices:{},quotations:{},report:{}},pages:{invoices:1,quotations:1},busy:false};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=()=>state.capabilities?.today||new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Johannesburg',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const plusDays=(value,days)=>{const date=new Date(value+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+Number(days));return date.toISOString().slice(0,10);};
const amount=value=>(Number(value||0)/100).toFixed(2);
const fmt=(value,currency=state.business?.profile.currency||'ZAR')=>new Intl.NumberFormat(state.business?.profile.locale||'en-ZA',{style:'currency',currency}).format((value||0)/100);
const readableDate=value=>InvoiceDocument.date(value,state.business?.profile.locale);
const option=(value,label,selected)=>`<option value="${esc(value)}" ${String(value)===String(selected)?'selected':''}>${esc(label)}</option>`;
const currencyOptions=selected=>InvoiceFinance.currencies.map(c=>option(c,c,selected)).join('');
const badge=status=>`<span class="badge ${esc(status)}">${esc(String(status).replaceAll('-',' '))}</span>`;
const pageHead=(title,description,actions='')=>`<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="row-actions">${actions}</div></div>`;
function toast(message,error=false){const node=$('#toast');node.textContent=message;node.className=error?'error':'';node.style.display='block';clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>node.style.display='none',error?8000:4500);}
function showError(error){const message=error.message||'Something went wrong.';const area=$('.modal-backdrop:last-of-type .form-error')||$('#content .form-error');if(area){area.textContent=message;area.hidden=false;area.focus();}toast(message,true);}
async function api(route,options={}){
  const mutation=options.method&&options.method!=='GET';
  if(mutation&&state.busy)throw Error('Please wait for the current action to finish.');
  const button=mutation&&document.activeElement?.tagName==='BUTTON'?document.activeElement:null;
  if(mutation){state.busy=true;if(button){button.disabled=true;button.setAttribute('aria-busy','true');}}
  try{
    const response=await fetch('/api'+route,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers},body:options.body?JSON.stringify(options.body):undefined});
    if(!response.ok){let body={};try{body=await response.json();}catch{}throw Object.assign(Error(body.error||`Request failed (${response.status}).`),{status:response.status});}
    return response.headers.get('content-type')?.includes('application/json')?response.json():response;
  }finally{if(mutation){state.busy=false;if(button?.isConnected){button.disabled=false;button.removeAttribute('aria-busy');}}}
}
const post=(route,body={})=>api(route,{method:'POST',body}),put=(route,body)=>api(route,{method:'PUT',body});
async function download(route,name){try{const response=await fetch('/api'+route,{credentials:'same-origin'});if(!response.ok){let data={};try{data=await response.json();}catch{}throw Error(data.error||'Download failed.');}const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}catch(error){showError(error);}}
const errorArea=()=>'<p class="form-error" role="alert" tabindex="-1" hidden></p>';
function formFields(data,fields){return fields.map(([name,label,type='text',full=false])=>`<label class="${full?'full':''}">${esc(label)}${type==='textarea'?`<textarea name="${name}">${esc(data[name])}</textarea>`:type==='select'?`<select name="${name}">${currencyOptions(data[name])}</select>`:`<input name="${name}" type="${type}" ${type==='number'?'min="0" step="0.01"':''} ${name==='name'?'required':''} value="${esc(data[name])}">`}</label>`).join('');}
function modal(title,html,buttons=[]){
  const previous=document.activeElement,node=$('#modalTemplate').content.firstElementChild.cloneNode(true),dialog=node.querySelector('.modal');
  node.querySelector('h2').textContent=title;const titleId='dialog-'+crypto.randomUUID();node.querySelector('h2').id=titleId;dialog.setAttribute('aria-labelledby',titleId);node.querySelector('.modal-body').innerHTML=errorArea()+html;
  const close=()=>{node.remove();previous?.isConnected&&previous.focus();};node.close=close;node.querySelector('.close').onclick=close;
  buttons.forEach(({label,style='secondary',click})=>{const button=document.createElement('button');button.type='button';button.className=style;button.textContent=label;button.onclick=async()=>{try{await click(node);}catch(error){showError(error);}};node.querySelector('.modal-actions').append(button);});
  node.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}if(event.key==='Tab'){const focus=[...dialog.querySelectorAll('button,input,select,textarea,a[href]')].filter(x=>!x.disabled&&x.offsetParent!==null);if(!focus.length)return;const first=focus[0],last=focus.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});
  node.querySelectorAll('form').forEach(form=>form.onsubmit=event=>{event.preventDefault();node.querySelector('.modal-actions .primary')?.click();});
  document.body.append(node);(dialog.querySelector('input,select,textarea')||node.querySelector('.close')).focus();return node;
}
function canLeave(){return !state.editor||JSON.stringify(state.editor)===state.baseline||confirm('Leave this editor and discard unsaved changes?');}
async function load(){
  try{state.me=await api('/me');state.capabilities=await api('/capabilities');$('#userEmail').textContent=state.me.email;$('#auth').hidden=true;$('#app').hidden=false;await loadBusinesses();}
  catch(error){if(error.status===401){$('#auth').hidden=false;$('#app').hidden=true;}else showError(error);}
}
async function loadBusinesses(){state.businesses=await api('/businesses');if(!state.businesses.length){state.business=null;$('#topNew').hidden=true;showSetup();return;}const saved=localStorage.getItem('invoiceBusiness');await chooseBusiness(state.businesses.some(b=>b.id===saved)?saved:state.businesses[0].id);}
async function refreshCustomers(){state.customers=await api('/customers?businessId='+state.business.id);}
async function refreshProducts(){state.products=await api('/products?businessId='+state.business.id);}
async function chooseBusiness(id){
  if(state.editor&&!canLeave()){$('#businessSelect').value=state.business.id;return;}
  const changed=state.business?.id!==id;state.business=await api('/businesses/'+id);state.business.design=InvoiceDocument.design(state.business.design);localStorage.setItem('invoiceBusiness',id);
  $('#businessSelect').innerHTML=state.businesses.map(b=>option(b.id,b.name,id)).join('');if(changed){state.filters={invoices:{},quotations:{},report:{}};state.pages={invoices:1,quotations:1};}
  await Promise.all([refreshCustomers(),refreshProducts()]);navigate(['setup','editor','detail'].includes(state.page)?'dashboard':state.page,true);
}
function navigate(page,force=false){
  if(!force&&!canLeave())return;if(!state.business&&page!=='setup'){showSetup();return;}
  state.viewSequence=(state.viewSequence||0)+1;state.editor=null;state.editing=null;state.baseline=null;state.page=page;$('.sidebar').classList.remove('open');$('#mobileMenu').setAttribute('aria-expanded','false');
  $$('.nav[data-nav]').forEach(button=>button.classList.toggle('active',button.dataset.nav===page));
  $('#breadcrumb').textContent=({dashboard:'Overview',invoices:'Invoices',quotations:'Quotations',customers:'Customers',products:'Products & services',business:'Business & brand'})[page]||page;$('#topNew').hidden=!state.business;
  if(page==='dashboard')renderDashboard();else if(page==='invoices'||page==='quotations')renderDocuments(page);else if(page==='customers'||page==='products')renderRecords(page);else if(page==='business')renderBusiness();
}
function showSetup(){state.page='setup';$('#content').innerHTML=`<section class="panel setup-card"><span class="eyebrow">GETTING STARTED</span><h1>Set up your business</h1><p class="muted">Your details and branding will be ready on every invoice and quotation.</p>${errorArea()}<form id="setupForm" class="form-grid">${formFields({currency:'ZAR'},[['name','Business name','text',true],['email','Business email','email'],['currency','Default currency','select'],['address','Business address','textarea',true]])}<label>Default payment days<input name="termsDays" type="number" min="0" max="365" step="1" value="14"></label><label>Quote validity days<input name="quoteDays" type="number" min="1" max="365" step="1" value="30"></label><div class="full"><button class="primary" type="submit">Create business →</button></div></form></section>`;$('#setupForm').onsubmit=async event=>{event.preventDefault();try{await post('/businesses',Object.fromEntries(new FormData(event.target)));await loadBusinesses();toast('Business created. Add your logo and banking details in Business & brand.');}catch(error){showError(error);}};}
function showBusinessModal(){modal('Add a business',`<form class="form-grid">${formFields({currency:'ZAR'},[['name','Business name','text',true],['currency','Default currency','select'],['address','Address','textarea',true]])}</form>`,[{label:'Create business',style:'primary',click:async node=>{const form=node.querySelector('form');if(!form.reportValidity())return;const result=await post('/businesses',Object.fromEntries(new FormData(form)));node.close();state.businesses=await api('/businesses');await chooseBusiness(result.id);navigate('business');}}]);}
async function renderRecords(type){
  const customer=type==='customers';$('#content').innerHTML=pageHead(customer?'Customers':'Products & services',customer?'Saved billing and contact details for your documents.':'Reusable products, prices and tax treatments.',`<button class="primary" id="addRecord">＋ Add ${customer?'customer':'item'}</button>`)+`<section class="panel">${errorArea()}<div class="toolbar"><input id="recordSearch" aria-label="Search records" placeholder="Search ${type}"><label class="check"><input id="archivedRecords" type="checkbox"> Include archived</label></div><div id="recordRows"></div></section>`;
  let records=customer?state.customers:state.products;
  function draw(){const query=$('#recordSearch').value.toLowerCase(),rows=records.filter(x=>JSON.stringify(x).toLowerCase().includes(query));$('#recordRows').innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>Name</th><th>${customer?'Email':'SKU'}</th><th>${customer?'Phone':'Price'}</th><th>Actions</th></tr></thead><tbody>${rows.map(x=>`<tr><td><strong>${esc(x.name)}</strong><small>${esc(x.address||x.description)}</small>${x.archived?badge('archived'):''}</td><td>${esc(customer?x.email:x.sku)}</td><td>${customer?esc(x.phone):fmt(x.priceCents,x.currency||state.business.profile.currency)}</td><td><div class="table-actions"><button data-edit="${x.id}">Edit</button><button data-archive="${x.id}">${x.archived?'Restore':'Archive'}</button>${customer?`<button data-history="${x.id}">History</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><b>No records found</b>Add a record or change your search.</div>';
    $$('[data-edit]').forEach(button=>button.onclick=()=>recordModal(type,records.find(x=>x.id===button.dataset.edit),()=>renderRecords(type)));
    $$('[data-archive]').forEach(button=>button.onclick=async()=>{const record=records.find(x=>x.id===button.dataset.archive);if(!record.archived&&!confirm(`Archive ${record.name}? Existing documents will keep their saved details.`))return;try{if(record.archived)await post(`/${type}/${record.id}/restore`,{businessId:state.business.id});else await api(`/${type}/${record.id}?businessId=${state.business.id}`,{method:'DELETE'});await Promise.all([refreshCustomers(),refreshProducts()]);renderRecords(type);}catch(error){showError(error);}});
    $$('[data-history]').forEach(button=>button.onclick=()=>{state.filters.invoices={customerId:button.dataset.history};state.pages.invoices=1;navigate('invoices');});
  }
  $('#recordSearch').oninput=draw;$('#archivedRecords').onchange=async event=>{try{records=await api(`/${type}?businessId=${state.business.id}&includeArchived=${event.target.checked?'1':'0'}`);draw();}catch(error){showError(error);}};$('#addRecord').onclick=()=>recordModal(type,null,()=>renderRecords(type));draw();
}
function recordModal(type,record=null,afterSave){
  const customer=type==='customers',value=record||{},data={...value,price:amount(value.priceCents),currency:value.currency||state.business.profile.currency,taxRate:value.taxRate??(state.business.profile.taxRegistered?state.business.profile.defaultTaxRate:0)};
  const fields=customer?[['name','Customer name','text',true],['email','Email','email'],['phone','Phone'],['address','Billing address','textarea',true],['registration','Registration number'],['taxNumber','Tax / VAT number']]:[['name','Item name','text',true],['description','Description','textarea',true],['sku','SKU / code'],['price','Default price','number'],['currency','Price currency','select'],['taxRate','Tax rate (%)','number'],['unit','Unit of measure']];
  modal(record?'Edit record':'Add record',`<form class="form-grid">${formFields(data,fields)}${customer?'':`<label>Tax treatment<select name="taxTreatment">${['standard','zero','exempt','non-taxable'].map(x=>option(x,x,value.taxTreatment||(state.business.profile.taxRegistered?'standard':'non-taxable'))).join('')}</select></label>`}</form>`,[{label:'Save',style:'primary',click:async node=>{const form=node.querySelector('form');if(!form.reportValidity())return;const input=Object.fromEntries(new FormData(form));if(record)await put(`/${type}/${record.id}?businessId=${state.business.id}`,input);else await post('/'+type,{...input,businessId:state.business.id});await Promise.all([refreshCustomers(),refreshProducts()]);node.close();afterSave?.();toast('Record saved.');}}]);
}
function initialise(){
  const theme=localStorage.getItem('invoiceTheme')||'light';document.documentElement.dataset.theme=theme;$('#themeToggle').textContent=theme==='dark'?'☀':'☾';
  $('#themeToggle').onclick=()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;localStorage.setItem('invoiceTheme',next);$('#themeToggle').textContent=next==='dark'?'☀':'☾';};
  $('#authForm').onsubmit=async event=>{event.preventDefault();try{await post(state.register?'/auth/register':'/auth/login',Object.fromEntries(new FormData(event.target)));event.target.password.value='';await load();}catch(error){showError(error);}};
  function toggleAuth(){state.register=!state.register;$('#authTitle').textContent=state.register?'Create your account':'Welcome back';$('#authSub').textContent=state.register?'Start invoicing with your own brand.':'Sign in to manage your invoices.';$('#authSubmit').textContent=state.register?'Create account':'Sign in';$('#authSwitch').innerHTML=state.register?'Already have an account? <button type="button" class="link" id="switchAuth">Sign in</button>':'New here? <button type="button" class="link" id="switchAuth">Create an account</button>';$('#authForm').password.autocomplete=state.register?'new-password':'current-password';$('#switchAuth').onclick=toggleAuth;}
  $('#switchAuth').onclick=toggleAuth;$('#signOut').onclick=async()=>{if(!canLeave())return;try{await post('/auth/logout');state.editor=null;state.business=null;state.me=null;$('#auth').hidden=false;$('#app').hidden=true;}catch(error){showError(error);}};
  $('#businessSelect').onchange=event=>chooseBusiness(event.target.value).catch(showError);$('#topNew').onclick=()=>newInvoice('invoices');$('#mobileMenu').onclick=()=>{const expanded=$('.sidebar').classList.toggle('open');$('#mobileMenu').setAttribute('aria-expanded',String(expanded));};$$('.nav[data-nav]').forEach(button=>button.onclick=()=>navigate(button.dataset.nav));
  window.addEventListener('resize',()=>$$('.preview-container').forEach(container=>container.resizePreview?.()));
  window.addEventListener('beforeunload',event=>{if(state.editor&&JSON.stringify(state.editor)!==state.baseline){event.preventDefault();event.returnValue='';}});load();
}
