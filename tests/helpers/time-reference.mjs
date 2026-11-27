// Small independent Float64 reference for the time contract. Not a production DSP.
function finiteArray(values,name){
  if(!values || !Number.isSafeInteger(values.length) || values.length<1)
    throw new RangeError(name+" must be nonempty");
  for(const v of values) if(!Number.isFinite(v)) throw new RangeError(name+" must be finite");
}
function frame(n){if(!Number.isSafeInteger(n))throw new RangeError("integer frame required");return n;}
export function referenceConvolution(x,h,{delay=0,reverse=false}={}){
  finiteArray(x,"input");finiteArray(h,"IR");frame(delay);
  const origin=frame(delay-(reverse?h.length-1:0));
  const samples=new Float64Array(x.length+h.length-1);
  frame(origin+samples.length-1);
  for(let e=0;e<x.length;e++)for(let k=0;k<h.length;k++)
    samples[e+(reverse?h.length-1-k:k)]+=x[e]*h[k];
  return {origin,samples};
}
export function sampleAt({origin,samples},n){
  return n>=origin&&n<origin+samples.length?samples[n-origin]:0;
}
export function reversePlaced(signal,start,end){
  frame(start);frame(end);
  if(end<=start)throw new RangeError("empty interval");
  if(signal.origin<start||signal.origin+signal.samples.length>end)
    throw new RangeError("interval must cover signal");
  return {origin:start,samples:Float64Array.from({length:end-start},(_,i)=>sampleAt(signal,end-1-i))};
}
export function readIR(h,age,{lo=0,hi=h.length,boundary="zero"}={}){
  if(!Number.isFinite(age)||!Number.isSafeInteger(lo)||!Number.isSafeInteger(hi)||lo<0||hi>h.length||lo>=hi)
    throw new RangeError("invalid IR reference");
  const mod=(v,m)=>((v%m)+m)%m;
  let a=age;
  if(boundary==="repeat")a=lo+mod(age-lo,hi-lo);
  else if(boundary==="pingpong"){
    const width=hi-lo-1;
    if(width===0)a=lo;
    else {const u=mod(age-lo,2*width);a=lo+Math.min(u,2*width-u);}
  }else if(boundary!=="zero")throw new RangeError("unknown boundary");
  if(a<lo||a>=hi)return 0;
  const i=Math.floor(a),f=a-i;
  if(f===0)return h[i];
  const next=i+1<hi?h[i+1]:boundary==="repeat"?h[lo]:0;
  return h[i]+(next-h[i])*f;
}
// q has excitation origin inputOrigin; clock is A over a finite integer timeline.
export function integratedRaw(q,h,clock,{inputOrigin=0,clockOrigin=0,start=clockOrigin,count=clock.length,delay=0,range}={}){
  finiteArray(q,"input");finiteArray(h,"IR");finiteArray(clock,"clock");
  [inputOrigin,clockOrigin,start,count,delay].forEach(frame);
  if(count<1||start<clockOrigin||frame(start+count)>frame(clockOrigin+clock.length))
    throw new RangeError("output outside clock");
  const samples=new Float64Array(count);
  for(let i=0;i<count;i++){
    const n=start+i;
    for(let j=0;j<q.length;j++){
      const p=frame(inputOrigin+j+delay);
      if(p>n)continue;
      if(p<clockOrigin)throw new RangeError("missing placement clock history");
      samples[i]+=q[j]*readIR(h,clock[n-clockOrigin]-clock[p-clockOrigin],range);
    }
  }
  return {origin:start,samples};
}
