import {validatePCM,checkPCMBudget,DEFAULT_PCM_BUDGET_BYTES} from "./convolution.mjs";
import {loopSourcePosition,nextSourceSampleIndex} from "../shared/atf/source-timeline.mjs";
import {createReflectedPCMSource} from "../shared/atf/reflected-pcm-source.mjs";

// T3 finite raw reference engine. It never allocates the input × IR matrix.
// Identical placement-clock anchors are mathematically equivalent in RAW
// mode only. Do not reuse this grouping for continuous per-event phases.
export const DEFAULT_INTEGRATED_TERM_BUDGET=8_000_000;
const integer=(n,label)=>{
  if(!Number.isSafeInteger(n))throw RangeError(label+" must be a safe integer");
  return n;
};
export function renderIntegratedRaw(input,ir,clock,{
  clockOrigin=0,start=clockOrigin,count,delay=0,range={},
  maxBytes=DEFAULT_PCM_BUDGET_BYTES,maxTerms=DEFAULT_INTEGRATED_TERM_BUDGET
}={}){
  const x=validatePCM(input),h=validatePCM(ir);
  if(x.sampleRate!==h.sampleRate||h.origin!==0)throw RangeError("invalid integrated PCM coordinates");
  if(!(clock instanceof Float64Array)&&!Array.isArray(clock))throw RangeError("finite clock history required");
  if(!clock.length)throw RangeError("finite clock history required");
  // Array.every skips holes; missing clock history must never become silence.
  for(let i=0;i<clock.length;i++)if(!Number.isFinite(clock[i]))throw RangeError("finite clock history required");
  integer(clockOrigin,"clock origin");integer(start,"output start");integer(delay,"placement");
  const clockEnd=integer(clockOrigin+clock.length,"clock end");
  count??=clockEnd-start;integer(count,"output count");
  const end=integer(start+count,"output end");
  if(count<1||start<clockOrigin||end>clockEnd)throw RangeError("output outside clock history");
  const placement=integer(x.origin+delay,"first placement");
  integer(placement+x.length,"placement end");
  if(placement<clockOrigin)throw RangeError("missing placement clock history");
  if(!Number.isSafeInteger(maxTerms)||maxTerms<1)throw RangeError("invalid integrated work budget");
  const {lo=0,hi=h.length,boundary="zero"}=range;
  if(!Number.isSafeInteger(lo)||!Number.isSafeInteger(hi)||lo<0||lo>=hi||hi>h.length||
    !["zero","repeat","pingpong"].includes(boundary))throw RangeError("invalid integrated IR range");
  const nCh=Math.max(x.channels.length,h.channels.length);
  const fixedBytes=4*(x.length*x.channels.length+h.length*h.channels.length+count*nCh)+8*clock.length;
  checkPCMBudget(fixedBytes,maxBytes);
  const reflected=boundary==="pingpong"?createReflectedPCMSource({
    channels:h.channels,startFrame:lo,endFrame:hi}):null;
  const loop={loopEnabled:boundary==="repeat",loopStartFrame:lo,loopEndFrame:hi};
  const channels=Array.from({length:nCh},()=>new Float32Array(count));
  const groups=new Map(),sums=new Float64Array(nCh);
  // Approximate retained metadata budget; JS engine object overhead varies.
  const bytesPerGroup=64+8*nCh;
  let cursor=0,terms=0,peakGroups=0,excitations=0;
  function admit(n){
    while(cursor<x.length&&placement+cursor<=n){
      const j=cursor++;
      let nonzero=false;
      for(const c of x.channels)if(c[j]!==0)nonzero=true;
      if(!nonzero)continue;
      const anchor=clock[placement+j-clockOrigin];
      if(!Number.isFinite(anchor))throw RangeError("missing placement clock history");
      let group=groups.get(anchor);
      if(!group){
        checkPCMBudget(fixedBytes+(groups.size+1)*bytesPerGroup,maxBytes);
        group=new Float64Array(nCh);groups.set(anchor,group);
      }
      for(let c=0;c<nCh;c++)group[c]+=x.channels[x.channels.length===1?0:c][j];
      if(group.every(v=>v===0))groups.delete(anchor);
      excitations++;peakGroups=Math.max(peakGroups,groups.size);
    }
  }
  for(let i=0;i<count;i++){
    const n=start+i;admit(n);sums.fill(0);
    const now=clock[n-clockOrigin];
    for(const [anchor,group] of groups){
      if(++terms>maxTerms)throw RangeError("Integrated raw work budget exceeded");
      const age=now-anchor;
      if(!Number.isFinite(age))throw RangeError("invalid integrated age");
      const a=reflected?reflected.toSourceFrame(age-lo):loopSourcePosition(age,loop);
      if(a<lo||a>=hi)continue;
      const k=Math.floor(a),f=a-k;
      // Zero extension is domain-specific; repeat interpolation uses the
      // shared endpoint neighbor, and reflected positions never cross hi-1.
      const next=k+1<hi?k+1:boundary==="repeat"?nextSourceSampleIndex(k,loop,h.length):-1;
      for(let c=0;c<nCh;c++){
        const hch=h.channels[h.channels.length===1?0:c];
        const value=f===0?hch[k]:hch[k]+((next<0?0:hch[next])-hch[k])*f;
        sums[c]+=group[c]*value;
      }
    }
    for(let c=0;c<nCh;c++){
      const value=Math.fround(sums[c]);
      if(!Number.isFinite(value))throw RangeError("nonfinite integrated output");
      channels[c][i]=value;
    }
  }
  return {origin:start,sampleRate:x.sampleRate,channels,
    history:{clockOrigin,clockEnd,firstPlacement:placement,admittedFrames:cursor,excitations},
    stats:{terms,peakGroups,retainedGroups:groups.size,maxTerms,estimatedBytes:fixedBytes+peakGroups*bytesPerGroup}};
}
