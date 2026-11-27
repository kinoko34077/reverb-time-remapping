import {mixWet} from "../shared/fw/dsp.mjs";

// Finite prepared PCM at one rate. Browser ConvolverNode owns FFT/partitioning;
// explicit mono calls own channel mapping instead of relying on implicit mixing.
export const DEFAULT_PCM_BUDGET_BYTES=64*1024*1024;
function integer(n,name){if(!Number.isSafeInteger(n))throw new RangeError(name+" must be integer");return n;}
function positive(n,name){integer(n,name);if(n<1)throw new RangeError(name+" must be positive");return n;}
function pcm(signal){
  const {channels,sampleRate,origin=0}=signal??{};
  if(!Number.isFinite(sampleRate)||sampleRate<=0)throw new RangeError("invalid sample rate");
  integer(origin,"origin");
  if(!Array.isArray(channels)||channels.length<1||channels.length>2||
     !channels.every(c=>c instanceof Float32Array))throw new RangeError("mono/stereo Float32 PCM required");
  const length=positive(channels[0].length,"PCM length");
  if(!channels.every(c=>c.length===length))throw new RangeError("channel lengths differ");
  for(const c of channels)for(const v of c)if(!Number.isFinite(v))throw new RangeError("PCM must be finite");
  integer(origin+length,"PCM end");
  return {channels,sampleRate,origin,length};
}
function budget(bytes,maxBytes){
  positive(maxBytes,"PCM budget");
  if(!Number.isSafeInteger(bytes)||bytes>maxBytes)throw new RangeError("prepared PCM memory estimate exceeds budget");
}
export function secondsToFrames(seconds,sampleRate){
  if(!Number.isFinite(seconds)||!Number.isFinite(sampleRate)||sampleRate<=0)
    throw new RangeError("invalid time/rate");
  const frames=Math.sign(seconds)*Math.round(Math.abs(seconds*sampleRate));
  return integer(frames===0?0:frames,"placement");
}
export async function nativeConvolveMono(x,h,sampleRate,Context=globalThis.OfflineAudioContext){
  if(typeof Context!=="function")throw new Error("OfflineAudioContext unavailable");
  const length=x.length+h.length-1;
  const ctx=new Context(1,length,sampleRate);
  const input=ctx.createBuffer(1,x.length,sampleRate);
  input.copyToChannel(x,0);
  const kernel=ctx.createBuffer(1,h.length,sampleRate);
  kernel.copyToChannel(h,0);
  const node=ctx.createConvolver();
  node.normalize=false;
  node.buffer=kernel;
  const source=ctx.createBufferSource();
  source.buffer=input;source.connect(node);node.connect(ctx.destination);
  source.start(0);
  const result=await ctx.startRendering();
  return Float32Array.from(result.getChannelData(0));
}
export async function renderConvolution(input,ir,{delay=0,reverse=false,renderMono=nativeConvolveMono,maxBytes=DEFAULT_PCM_BUDGET_BYTES}={}){
  const x=pcm(input),h=pcm(ir);
  if(x.sampleRate!==h.sampleRate)throw new RangeError("prepare source and IR at the same sample rate");
  if(h.origin!==0)throw new RangeError("IR must use zero-based age");
  integer(delay,"delay");
  if(typeof reverse!=="boolean")throw new TypeError("reverse must be boolean");
  const origin=integer(x.origin+delay-(reverse?h.length-1:0),"Wet origin");
  const length=positive(x.length+h.length-1,"Wet length"),count=Math.max(x.channels.length,h.channels.length);
  integer(origin+length,"Wet end");
  // Conservative estimate of simultaneously retained PCM, working copies and
  // returned channels; native engine internal FFT memory is not guaranteed.
  budget(4*(x.length*x.channels.length+h.length*h.channels.length+count*length+3*(x.length+h.length+length)),maxBytes);
  const channels=[];
  for(let c=0;c<count;c++){
    const source=x.channels[x.channels.length===1?0:c];
    const kernel=h.channels[h.channels.length===1?0:c];
    const prepared=reverse?Float32Array.from(kernel).reverse():kernel;
    const out=await renderMono(source,prepared,x.sampleRate);
    if(!(out instanceof Float32Array)||out.length!==length||!out.every(Number.isFinite))
      throw new Error("convolution returned invalid PCM");
    channels.push(out);
  }
  return {origin,sampleRate:x.sampleRate,channels};
}
export function comparisonInterval(input,ir,delay=0){
  const x=pcm(input),h=pcm(ir);integer(delay,"delay");
  if(x.sampleRate!==h.sampleRate||h.origin!==0)throw new RangeError("invalid IR coordinates");
  const normal=integer(x.origin+delay,"normal origin");
  return {start:Math.min(x.origin,integer(normal-(h.length-1),"reverse origin")),
    end:Math.max(x.origin+x.length,integer(normal+x.length+h.length-1,"normal end"))};
}
export function alignPCM(signal,{start,end,channelCount,maxBytes=DEFAULT_PCM_BUDGET_BYTES}={}){
  const s=pcm(signal);integer(start,"start");integer(end,"end");
  const length=positive(end-start,"alignment length");
  if(s.origin<start||s.origin+s.length>end)throw new RangeError("interval must cover PCM");
  if(![1,2].includes(channelCount)||channelCount<s.channels.length)throw new RangeError("unsupported channel mapping");
  budget(4*channelCount*length,maxBytes);
  const channels=Array.from({length:channelCount},(_,c)=>{
    const out=new Float32Array(length);
    out.set(s.channels[s.channels.length===1?0:c],s.origin-start);return out;
  });
  return {origin:start,sampleRate:s.sampleRate,channels};
}
export function mixAligned(dry,wet,fraction,{maxBytes=DEFAULT_PCM_BUDGET_BYTES}={}){
  const a=pcm(dry),b=pcm(wet);
  if(a.origin!==b.origin||a.sampleRate!==b.sampleRate||a.length!==b.length||a.channels.length!==b.channels.length)
    throw new RangeError("align Dry and Wet first");
  budget(4*a.channels.length*a.length,maxBytes);
  return {origin:a.origin,sampleRate:a.sampleRate,
    channels:a.channels.map((c,i)=>mixWet(c,b.channels[i],fraction))};
}
// One explicit comparison-wide attenuation, not a kernel normalization.
export function previewGain(signals,requested=1,ceiling=.9){
  if(!Number.isFinite(requested)||requested<0||!Number.isFinite(ceiling)||ceiling<=0||ceiling>1)
    throw new RangeError("invalid preview gain");
  let peak=0;
  for(const signal of signals)for(const c of pcm(signal).channels)for(const v of c)peak=Math.max(peak,Math.abs(v));
  return {peak,requested,applied:peak===0?requested:Math.min(requested,ceiling/peak),ceiling};
}

// Reuse the same PCM coordinate/size checks in finite IR synthesis.
export {pcm as validatePCM,budget as checkPCMBudget};
