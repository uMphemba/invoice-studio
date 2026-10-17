(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InvoiceFinance = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const currencies = ['ZAR','USD','EUR','GBP','AUD','CAD','NZD','CHF','JPY','INR','KES','NGN'];
  const invalid = message => { throw Object.assign(new Error(message), {status:400}); };
  const quantum = currency => currency === 'JPY' ? 100 : 1;
  const roundRatio = (numerator, denominator, step=1) => {
    const divisor = BigInt(denominator) * BigInt(step);
    return Number((BigInt(numerator) + divisor / 2n) / divisor) * step;
  };
  function money(value, currency='ZAR') {
    const s = String(value ?? 0).trim();
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) invalid('Enter a non-negative amount with at most twelve whole digits and two decimal places.');
    const [whole, fraction=''] = s.split('.');
    const result = Number(whole)*100 + Number((fraction+'00').slice(0,2));
    if (result % quantum(currency)) invalid(`${currency} amounts must be whole numbers.`);
    return result;
  }
  function rate(value) {
    const s=String(value ?? 0).trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(s) || Number(s)>100) invalid('Tax and discount percentages must be between 0 and 100, with at most two decimals.');
    return Number(s);
  }
  function allocate(total, weights, step=1) {
    const sum=weights.reduce((a,b)=>a+b,0);
    if (!total || !sum) return weights.map(()=>0);
    const units=BigInt(total/step), divisor=BigInt(sum);
    const parts=weights.map((weight,index)=>({index, value:Number(units*BigInt(weight)/divisor)*step, remainder:units*BigInt(weight)%divisor}));
    let remainder=total-parts.reduce((n,x)=>n+x.value,0);
    [...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1).forEach(part=>{
      if (remainder>=step) { part.value+=step; remainder-=step; }
    });
    return parts.map(x=>x.value);
  }
  function calculate(input) {
    const currency=input.currency || 'ZAR', step=quantum(currency);
    if (!currencies.includes(currency)) invalid('Select a supported currency.');
    if (!Array.isArray(input.items) || !input.items.length || input.items.length>200) invalid('Add between 1 and 200 invoice items.');
    const pct=(value,percent)=>roundRatio(BigInt(value)*BigInt(Math.round(percent*100)),10000,step);
    const items=input.items.map((item,index)=>{
      const description=String(item.description??'').trim().slice(0,500);
      if (!description) invalid(`Enter a description for item ${index+1}.`);
      const q=String(item.quantity??'');
      if (!/^\d{1,6}(\.\d{1,3})?$/.test(q) || Number(q)<=0 || Number(q)>100000) invalid(`Item ${index+1}: quantity must be positive, with at most three decimals.`);
      const [whole,fraction='']=q.split('.');
      const quantityMills=Number(whole)*1000+Number((fraction+'000').slice(0,3));
      const unitCents=money(item.unitPrice,currency), grossCents=roundRatio(BigInt(quantityMills)*BigInt(unitCents),1000,step);
      if(!Number.isSafeInteger(grossCents))invalid(`Item ${index+1} exceeds the supported amount range.`);
      const discountRate=rate(item.discountRate), discountCents=pct(grossCents,discountRate);
      const taxTreatment=['standard','zero','exempt','non-taxable'].includes(item.taxTreatment)?item.taxTreatment:'standard';
      return {description,sku:String(item.sku??'').trim().slice(0,80),unit:String(item.unit||'each').trim().slice(0,30),quantity:Number(q),unitPrice:(unitCents/100).toFixed(2),discountRate,taxTreatment,taxRate:taxTreatment==='standard'?rate(item.taxRate):0,grossCents,discountCents,netCents:grossCents-discountCents};
    });
    const subtotalCents=items.reduce((n,x)=>n+x.grossCents,0), lineDiscountCents=items.reduce((n,x)=>n+x.discountCents,0);
    if(!Number.isSafeInteger(subtotalCents)||!Number.isSafeInteger(lineDiscountCents))invalid('Invoice amount exceeds the supported range.');
    const invoiceDiscountRate=rate(input.invoiceDiscountRate),invoiceDiscountCents=pct(subtotalCents-lineDiscountCents,invoiceDiscountRate);
    const discounts=allocate(invoiceDiscountCents,items.map(x=>x.netCents),step);
    items.forEach((item,i)=>{item.invoiceDiscountCents=discounts[i];item.taxableCents=item.netCents-discounts[i];item.taxCents=pct(item.taxableCents,item.taxRate);});
    const shippingCents=money(input.shipping??0,currency),shippingTaxRate=rate(input.shippingTaxRate),shippingTaxCents=pct(shippingCents,shippingTaxRate);
    const taxCents=items.reduce((n,x)=>n+x.taxCents,shippingTaxCents);
    const totalCents=subtotalCents-lineDiscountCents-invoiceDiscountCents+shippingCents+taxCents;
    if (!Number.isSafeInteger(totalCents)) invalid('Invoice amount exceeds the supported range.');
    return {items,subtotalCents,lineDiscountCents,invoiceDiscountRate,invoiceDiscountCents,shippingCents,shippingTaxRate,shippingTaxCents,taxCents,totalCents};
  }
  return {currencies,quantum,roundRatio,money,rate,allocate,calculate};
});
