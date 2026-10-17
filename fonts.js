const fs=require('node:fs');
const path=require('node:path');
const cache=new Map();
function loadFont(family='Arial',bold=false){
  const key=family+':'+bold;if(cache.has(key))return cache.get(key);
  const names={Arial:['arial.ttf','arialbd.ttf'],Georgia:['georgia.ttf','georgiab.ttf'],Verdana:['verdana.ttf','verdanab.ttf'],Tahoma:['tahoma.ttf','tahomabd.ttf']};
  const windows=path.join(process.env.WINDIR||'C:\\Windows','Fonts',(names[family]||names.Arial)[bold?1:0]);
  const files=[windows,`/usr/share/fonts/truetype/dejavu/DejaVuSans${bold?'-Bold':''}.ttf`,`/usr/share/fonts/truetype/liberation2/LiberationSans-${bold?'Bold':'Regular'}.ttf`];
  const file=files.find(x=>fs.existsSync(x));if(!file){cache.set(key,null);return null;}
  const bytes=fs.readFileSync(file),tables={};
  for(let i=0,count=bytes.readUInt16BE(4);i<count;i++){const at=12+i*16;tables[bytes.toString('ascii',at,at+4)]={offset:bytes.readUInt32BE(at+8),length:bytes.readUInt32BE(at+12)};}
  if(!tables.head||!tables.hhea||!tables.hmtx||!tables.cmap){cache.set(key,null);return null;}
  const head=tables.head.offset,hhea=tables.hhea.offset,units=bytes.readUInt16BE(head+18),metrics=bytes.readUInt16BE(hhea+34),cmap=tables.cmap.offset;
  const scale=n=>Math.round(n*1000/units),bbox=[36,38,40,42].map(offset=>scale(bytes.readInt16BE(head+offset)));
  let mapping=null;
  for(let i=0,count=bytes.readUInt16BE(cmap+2);i<count;i++){const at=cmap+4+i*8,platform=bytes.readUInt16BE(at),encoding=bytes.readUInt16BE(at+2),offset=cmap+bytes.readUInt32BE(at+4),format=bytes.readUInt16BE(offset);if((platform===3||platform===0)&&[4,12].includes(format)){if(!mapping||format===12&&encoding===10)mapping={offset,format};}}
  function glyph(code){
    if(!mapping)return 0;const o=mapping.offset;
    if(mapping.format===12){const count=bytes.readUInt32BE(o+12);let lo=0,hi=count-1;while(lo<=hi){const m=(lo+hi)>>1,at=o+16+m*12,start=bytes.readUInt32BE(at),end=bytes.readUInt32BE(at+4);if(code<start)hi=m-1;else if(code>end)lo=m+1;else return bytes.readUInt32BE(at+8)+code-start;}return 0;}
    const count=bytes.readUInt16BE(o+6)/2,end=o+14,start=end+count*2+2,delta=start+count*2,ranges=delta+count*2;
    for(let i=0;i<count;i++){if(code>bytes.readUInt16BE(end+i*2))continue;if(code<bytes.readUInt16BE(start+i*2))return 0;const shift=bytes.readInt16BE(delta+i*2),range=bytes.readUInt16BE(ranges+i*2);if(!range)return (code+shift)&65535;const at=ranges+i*2+range+(code-bytes.readUInt16BE(start+i*2))*2;if(at+2>bytes.length)return 0;const g=bytes.readUInt16BE(at);return g?(g+shift)&65535:0;}return 0;
  }
  const width=code=>scale(bytes.readUInt16BE(tables.hmtx.offset+Math.min(glyph(code),metrics-1)*4));
  const font={bytes,name:(family+(bold?'-Bold':'-Regular')).replace(/[^A-Za-z0-9-]/g,''),glyph,width,bbox,ascent:scale(bytes.readInt16BE(hhea+4)),descent:scale(bytes.readInt16BE(hhea+6)),serif:family==='Georgia',bold};cache.set(key,font);return font;
}
module.exports={loadFont};
