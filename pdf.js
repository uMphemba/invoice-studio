const zlib=require('node:zlib');
const {imageData}=require('./image');
const {loadFont}=require('./fonts');
const Design=require('./public/document');
const Finance=require('./public/finance');
const W=595.28,H=841.89;
const colour=hex=>[1,3,5].map(i=>(parseInt(hex.slice(i,i+2),16)/255).toFixed(3)).join(' ');
const codes=s=>Array.from(String(s??'')).map(c=>c.codePointAt(0)>65535?0xfffd:c.codePointAt(0));
class PDF {
  constructor(family){this.objects=[];this.pages=[];this.fonts=[loadFont(family),loadFont(family,true)];this.used=[new Set(),new Set()];this.fontRefs=[this.add(''),this.add('')];this.image=null;}
  add(value){this.objects.push(value);return this.objects.length;}
  stream(data,extra=''){const bytes=Buffer.isBuffer(data)?data:Buffer.from(data,'latin1');return this.add(Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${extra} >>\nstream\n`),bytes,Buffer.from('\nendstream')]));}
  page(){const p={ops:[],doc:this};this.pages.push(p);return p;}
  encode(value,bold){const index=bold?1:0,font=this.fonts[index];if(font){return '<'+codes(value).map(code=>{this.used[index].add(code);return code.toString(16).padStart(4,'0');}).join('')+'>';}return '('+String(value??'').normalize('NFKD').replace(/[^\x20-\x7e]/g,'?').replace(/[\\()]/g,'\\$&')+')';}
  width(value,size,bold=false){const font=this.fonts[bold?1:0];return codes(value).reduce((n,c)=>n+(font?font.width(c):520),0)*size/1000;}
  embed(index){
    const font=this.fonts[index],ref=this.fontRefs[index];
    if(!font){this.objects[ref-1]=`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica${index?'-Bold':''} >>`;return;}
    const file=this.stream(zlib.deflateSync(font.bytes),`/Filter /FlateDecode /Length1 ${font.bytes.length}`);
    const descriptor=this.add(`<< /Type /FontDescriptor /FontName /${font.name} /Flags ${font.serif?34:32} /FontBBox [${font.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${font.ascent} /Descent ${font.descent} /CapHeight ${font.ascent} /StemV ${index?110:80} /FontFile2 ${file} 0 R >>`);
    const map=Buffer.alloc(131072);for(const code of this.used[index])map.writeUInt16BE(font.glyph(code)&65535,code*2);
    const mapRef=this.stream(zlib.deflateSync(map),'/Filter /FlateDecode');
    const widths=[...this.used[index]].sort((a,b)=>a-b).map(code=>`${code} [${font.width(code)}]`).join(' ');
    const descendant=this.add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap ${mapRef} 0 R >>`);
    const unicode=this.stream('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /InvoiceUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend');
    this.objects[ref-1]=`<< /Type /Font /Subtype /Type0 /BaseFont /${font.name} /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${unicode} 0 R >>`;
  }
  render(){
    this.embed(0);this.embed(1);let imageRef=0;
    if(this.image){let mask=0;const im=this.image;if(im.alpha)mask=this.stream(im.alpha,`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`);imageRef=this.stream(im.data,`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${im.filter}${mask?` /SMask ${mask} 0 R`:''}`);}
    const parent=this.add(''),pages=[];
    this.pages.forEach(p=>{const content=this.stream(p.ops.join('\n'));pages.push(this.add(`<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${this.fontRefs[0]} 0 R /F2 ${this.fontRefs[1]} 0 R >> ${imageRef?`/XObject << /Logo ${imageRef} 0 R >>`:''} >> /Contents ${content} 0 R >>`));});
    this.objects[parent-1]=`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map(x=>x+' 0 R').join(' ')}] >>`;
    const catalog=this.add(`<< /Type /Catalog /Pages ${parent} 0 R >>`),chunks=[Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n','latin1')],offsets=[0];let length=chunks[0].length;
    this.objects.forEach((object,i)=>{offsets.push(length);const bytes=Buffer.isBuffer(object)?object:Buffer.from(object,'latin1'),start=Buffer.from(`${i+1} 0 obj\n`),end=Buffer.from('\nendobj\n');chunks.push(start,bytes,end);length+=start.length+bytes.length+end.length;});
    const xref=length;chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${offsets.length} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`));return Buffer.concat(chunks);
  }
}
function text(p,x,y,value,size=10,bold=false,color='0.12 0.2 0.17',align='left'){
  if(align==='right')x-=p.doc.width(value,size,bold);if(align==='center')x-=p.doc.width(value,size,bold)/2;
  p.ops.push(`${color} rg BT /F${bold?2:1} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${(H-y).toFixed(2)} Tm ${p.doc.encode(value,bold)} Tj ET`);
}
function rect(p,x,y,w,h,color){p.ops.push(`${color} rg ${x.toFixed(2)} ${(H-y-h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);}
function line(p,x,y,w,color,width=.6){p.ops.push(`${color} RG ${width} w ${x.toFixed(2)} ${(H-y).toFixed(2)} m ${(x+w).toFixed(2)} ${(H-y).toFixed(2)} l S`);}
function wrap(doc,value,width,size,bold=false){
  const output=[];
  String(value??'').split(/\r?\n/).forEach(paragraph=>{let current='';for(const word of paragraph.split(/\s+/)){if(!word)continue;const candidate=current?current+' '+word:word;if(doc.width(candidate,size,bold)<=width){current=candidate;continue;}if(current){output.push(current);current='';}let part='';for(const letter of word){if(part&&doc.width(part+letter,size,bold)>width){output.push(part);part='';}part+=letter;}current=part;}output.push(current);});return output;
}
function drawInvoice(inv){
  const d=inv.data,b=d.businessSnapshot||{},s=Design.design(d.design),doc=new PDF(s.font),m=s.margin,right=W-m,width=W-2*m,accent=colour(s.accent),secondary=colour(s.secondary),muted='0.37 0.45 0.41';
  const size=Math.max(9,s.fontSize-1),leading=size+4,isCredit=inv.kind==='credit',isQuote=inv.kind==='quotation',money=n=>new Intl.NumberFormat(b.locale||'en-ZA',{style:'currency',currency:inv.currency}).format((n||0)/100),date=value=>Design.date(value,b.locale);
  doc.image=imageData(d.logoSnapshot);let page=doc.page(),y=m;
  const bottom=H-m-25;
  const heading=isCredit?'CREDIT NOTE':isQuote&&['INVOICE','TAX INVOICE'].includes(s.heading)?'QUOTATION':s.heading;
  const footerText=()=>doc.pages.forEach((p,i)=>text(p,right,H-m+4,`${i+1} / ${doc.pages.length}`,8,false,muted,'right'));
  function ensure(height,withTable=false){if(y+height<=bottom)return;page=doc.page();y=m;text(page,m,y+10,`${heading} · ${inv.number||'DRAFT'} (continued)`,11,true,accent);y+=30;if(withTable)tableHeader();}
  function paragraph(value,x=m,w=width,fontSize=size,bold=false,color=muted){for(const row of wrap(doc,value,w,fontSize,bold)){ensure(fontSize+5);text(page,x,y+fontSize,row,fontSize,bold,color);y+=fontSize+5;}}
  function title(value){ensure(25);y+=10;text(page,m,y,value.toUpperCase(),10,true,accent);y+=10;}
  const estimate=wrap(doc,b.name,width*.58,17,true).length*22+wrap(doc,b.address,width*.58,9).length*14;
  if(estimate>280)s.headerLayout='stacked';
  const brandWidth=s.headerLayout==='stacked'?width:width*.58,brandTop=y+25;
  line(page,m,y,width,accent,s.template==='creative'?8:4);y=brandTop;
  if(s.headerLayout==='banner')rect(page,m,y-12,width,80,secondary);
  function logo(){if(!doc.image)return;const im=doc.image,maxWidth=Math.min(s.logoWidth,brandWidth),scale=Math.min(maxWidth/im.w,90/im.h),w=im.w*scale,h=im.h*scale,x=s.logoAlign==='right'?m+brandWidth-w:s.logoAlign==='center'?m+(brandWidth-w)/2:m;page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(H-y-h).toFixed(2)} cm /Logo Do Q`);y+=h+12;}
  let brandX=m,brandTextWidth=brandWidth,logoBottom=0;
  if(s.logoPlacement==='beside'&&doc.image){const im=doc.image,scale=Math.min(Math.min(s.logoWidth,brandWidth*.38)/im.w,90/im.h),w=im.w*scale,h=im.h*scale;const logoX=s.logoAlign==='right'?m+brandWidth-w:m;page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${logoX.toFixed(2)} ${(H-y-h).toFixed(2)} cm /Logo Do Q`);brandTextWidth=brandWidth-w-12;brandX=s.logoAlign==='right'?m:m+w+12;logoBottom=y+h+12;}
  else if(s.logoPlacement!=='below')logo();
  paragraph(b.name,brandX,brandTextWidth,17,true,accent);paragraph(b.address,brandX,brandTextWidth,9);paragraph([b.email,b.phone].filter(Boolean).join(' · '),brandX,brandTextWidth,9);if(b.website)paragraph(b.website,brandX,brandTextWidth,9);y=Math.max(y,logoBottom);
  if(s.logoPlacement==='below')logo();
  const brandBottom=y;
  if(s.headerLayout==='stacked'){y+=12;paragraph(heading,m,width,25,true,accent);paragraph(inv.number||'DRAFT',m,width,12,true);paragraph(`${isCredit?'Credit date':'Issue date'}: ${date(d.issueDate)}`,m,width,9);if(!isCredit)paragraph(`${isQuote?'Valid until':'Due date'}: ${date(d.dueDate)} · ${inv.status}`,m,width,9);}
  else{let metaY=brandTop+8;const metaX=right,metaWidth=width*.37;for(const row of wrap(doc,heading,metaWidth,22,true)){text(page,metaX,metaY,row,22,true,accent,'right');metaY+=27;}metaY+=6;for(const numberLine of wrap(doc,inv.number||'DRAFT',metaWidth,11,true)){text(page,metaX,metaY,numberLine,11,true,undefined,'right');metaY+=15;}metaY+=12;const values=[`${isCredit?'Credit date':'Issue date'}: ${date(d.issueDate)}`,...(!isCredit?[`${isQuote?'Valid until':'Due date'}: ${date(d.dueDate)}`,`Status: ${inv.status}`]:[]),...(d.poNumber?[`PO: ${d.poNumber}`]:[]),...(d.reference?[`Reference: ${d.reference}`]:[])];values.forEach(value=>wrap(doc,value,metaWidth,9).forEach(row=>{text(page,metaX,metaY,row,9,false,muted,'right');metaY+=14;}));y=Math.max(brandBottom,metaY);}
  if(isCredit){title(`Credit against ${inv.originalNumber}`);paragraph(inv.reason);}
  y+=12;title(s.billToTitle);paragraph(d.customer.name,m,width,12,true);paragraph(d.customer.address);
  if(s.showCustomerDetails){paragraph([d.customer.email,d.customer.phone].filter(Boolean).join(' · '));if(d.customer.registration)paragraph(`Registration: ${d.customer.registration}`);if(d.customer.taxNumber)paragraph(`Tax / VAT: ${d.customer.taxNumber}`);}
  if(s.showBusinessDetails){title(s.fromTitle);const details=[b.registration&&`Registration: ${b.registration}`,b.taxNumber&&`Tax / VAT: ${b.taxNumber}`,b.terms,b.paymentMethods].filter(Boolean);if(details.length)paragraph(details.join('\n'));}
  title(s.itemsTitle);y+=5;
  const cols=[{key:'description',title:'Description',weight:45,align:'left'},...(s.showQuantity?[{key:'quantity',title:'Qty',weight:7}]:[]),...(s.showUnit?[{key:'unit',title:'Unit',weight:8}]:[]),...(s.showRate?[{key:'rate',title:'Rate',weight:15}]:[]),...(s.showDiscount?[{key:'discount',title:'Disc.',weight:8}]:[]),...(s.showTax?[{key:'tax',title:'Tax',weight:10}]:[]),{key:'amount',title:'Amount',weight:19}],weights=cols.reduce((n,x)=>n+x.weight,0);
  let cx=m;cols.forEach(col=>{col.x=cx;col.width=width*col.weight/weights;cx+=col.width;});
  function tableHeader(){rect(page,m,y,width,28,accent);cols.forEach(col=>text(page,col.align==='left'?col.x+6:col.x+col.width-5,y+18,col.title,8,true,'1 1 1',col.align||'right'));y+=28;}
  ensure(65);tableHeader();
  d.items.forEach((item,index)=>{
    const lines=wrap(doc,item.description,cols[0].width-12,size).map(value=>({value,size})),sku=s.showSku&&item.sku?wrap(doc,`SKU ${item.sku}`,cols[0].width-12,8).map(value=>({value,size:8})):[],all=[...lines,...sku];
    const values={quantity:String(item.quantity),unit:item.unit||'each',rate:money(Finance.money(item.unitPrice,inv.currency)),discount:`${item.discountRate||0}%`,tax:item.taxTreatment==='standard'?`${item.taxRate||0}%`:item.taxTreatment||'non-taxable',amount:money(item.taxableCents+item.taxCents)};
    let cursor=0;
    while(cursor<all.length){
      ensure(leading+2*s.spacing,true);const capacity=Math.max(1,Math.floor((bottom-y-2*s.spacing)/leading)),chunk=all.slice(cursor,cursor+capacity),height=Math.max(size+2*s.spacing,chunk.length*leading+2*s.spacing);
      if(s.tableStyle==='striped'&&index%2)rect(page,m,y,width,height,secondary);
      chunk.forEach((row,i)=>text(page,m+6,y+s.spacing+size+i*leading,row.value,row.size,false,row.size===8?muted:undefined));
      if(cursor===0)cols.slice(1).forEach(col=>{let fontSize=Math.min(size,9);while(fontSize>4.5&&doc.width(values[col.key],fontSize)>col.width-10)fontSize-=.5;text(page,col.x+col.width-5,y+s.spacing+size,values[col.key],fontSize,false,undefined,'right');});
      if(s.tableStyle!=='plain')line(page,m,y+height,width,'0.83 0.88 0.85');y+=height;cursor+=chunk.length;
      if(cursor<all.length)ensure(bottom-y+1,true);
    }
  });
  if(s.showTax){title('Tax summary');Design.taxSummary(d).forEach(group=>paragraph(`${group.label} · Net base ${money(group.base)} · Tax ${money(group.tax)}`,m,width,9));}
  const totals=[['Subtotal',d.subtotalCents],['Line discounts',-(d.lineDiscountCents||0)],['Invoice discount',-(d.invoiceDiscountCents||0)],['Tax',d.taxCents],['Shipping / charges',d.shippingCents],[isCredit?'Credit total':'Total',inv.totalCents,true],...(!isCredit&&!isQuote?[...(inv.creditedCents?[['Credit notes',-inv.creditedCents]]:[]),['Payments less refunds',inv.paidCents],['Balance due',inv.balanceCents,true],...(inv.refundDueCents?[['Refund due',inv.refundDueCents,true]]:[])]:[])];
  ensure(totals.length*23+20);y+=20;
  const totalX=m+width*.48;
  totals.forEach(([label,value,big])=>{if(big){y+=8;line(page,totalX,y-10,right-totalX,accent,1);}text(page,totalX,y+10,label,big?12:10,!!big,big?accent:muted);let fontSize=big?12:10;while(fontSize>7&&doc.width(money(value),fontSize,!!big)>width*.28)fontSize-=.5;text(page,right,y+10,money(value),fontSize,!!big,big?accent:muted,'right');y+=big?28:21;});
  if(s.showBanking){title(s.paymentTitle);paragraph(b.banking);paragraph(d.instructions||b.instructions);}
  if(s.showNotes&&d.notes){title(s.notesTitle);paragraph(d.notes);}
  if(s.footer){y+=15;for(const row of wrap(doc,s.footer,width,8)){ensure(12);text(page,s.footerAlign==='center'?W/2:s.footerAlign==='right'?right:m,y+8,row,8,false,muted,s.footerAlign);y+=12;}}
  footerText();return doc.render();
}
module.exports={drawInvoice,imageData};
