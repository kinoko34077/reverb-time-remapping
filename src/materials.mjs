import {DEFAULT_PCM_BUDGET_BYTES,checkPCMBudget,validatePCM} from "./convolution.mjs";
import {openWavChunkSource} from "../shared/fw/wav-chunk-source.mjs";

// Deterministic, locally generated comparison fixtures; no external recordings.
export const SAMPLE_RATE=48000;
export const SOURCE_TYPES=["impulse","sine","square","saw","noise","chord","piano-like","drums-like"];
export const IR_TYPES=["delay","sparse","dense","band-decay"];
const tau=2*Math.PI;
function random(seed=731){return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1;};}
function frames(seconds,sr){const n=Math.round(seconds*sr);if(!Number.isSafeInteger(n)||n<1||n>sr*12)throw RangeError("生成素材は0–12秒の有限区間です");return n;}
export function makeSource(kind="impulse",{sampleRate=SAMPLE_RATE,seconds=2,frequency=440}={}){
  if(!SOURCE_TYPES.includes(kind)||!Number.isFinite(frequency)||frequency<=0||frequency>=sampleRate/2)throw RangeError("音源の設定が範囲外です");
  const n=frames(seconds,sampleRate),noise=random(),a=new Float32Array(n);
  for(let i=0;i<n;i++){
    const t=i/sampleRate,p=t*frequency,edge=Math.min(1,i/120,(n-1-i)/120);
    let v=0;
    if(kind==="impulse")v=i===0?1:0;
    else if(kind==="sine")v=.4*Math.sin(tau*p);
    else if(kind==="square"||kind==="saw"){
      for(let k=1;k<=Math.min(32,Math.floor((sampleRate*.49)/frequency));k++){
        if(kind==="square"&&k%2===0)continue;
        v+=.24*Math.sin(tau*p*k)/k;
      }
    }else if(kind==="noise")v=.24*noise();
    else if(kind==="chord")for(const semitone of [0,4,7])v+=.12*Math.sin(tau*p*2**(semitone/12));
    else if(kind==="piano-like"){
      const k=Math.floor(t/.5),u=t-k*.5,f=frequency*2**([0,4,7,12][k%4]/12);
      for(let j=1;j<=5;j++)v+=.15/j*Math.sin(tau*f*j*u)*Math.exp(-u*(4+j));
      v*=Math.min(1,u*500);
    }else{
      const u=t%0.5;v=.35*Math.sin(tau*(55*u+3*(1-Math.exp(-u*40))))*Math.exp(-u*18)+.18*noise()*Math.exp(-u*35);
    }
    a[i]=kind==="impulse"?v:v*edge;
  }
  return {sampleRate,origin:0,channels:[a]};
}
export function makeIR(kind="dense",{sampleRate=SAMPLE_RATE,seconds=1.5}={}){
  if(!IR_TYPES.includes(kind))throw RangeError("未知のIR");
  const n=frames(seconds,sampleRate),noise=random(91);
  const a=new Float32Array(n),b=new Float32Array(n);
  if(kind==="delay"){a[0]=b[0]=.5;a[n-1]=b[n-1]=.5;}
  else if(kind==="sparse"){
    for(const [p,g] of [[.02,.5],[.09,.3],[.17,-.18],[.31,.12],[.76,.06]]){
      a[Math.floor(p*(n-1))]+=g;b[Math.floor(Math.min(.99,p+.015)*(n-1))]+=g;
    }
  }else{
    let lowL=0,lowR=0;
    for(let i=0;i<n;i++){
      const t=i/sampleRate,decay=Math.exp(-6*i/n),l=noise(),r=noise();
      lowL+=.08*(l-lowL);lowR+=.08*(r-lowR);
      a[i]=.025*(kind==="band-decay"?lowL*decay+(l-lowL)*Math.exp(-14*i/n):l*decay);
      b[i]=.025*(kind==="band-decay"?lowR*decay+(r-lowR)*Math.exp(-14*i/n):r*decay);
    }
    a[0]+=.35;b[Math.min(n-1,Math.round(.008*sampleRate))]+=.35;
  }
  return {sampleRate,origin:0,channels:[a,b]};
}
export async function readLocalWav(file,{sampleRate=SAMPLE_RATE,maxBytes=DEFAULT_PCM_BUDGET_BYTES,signal}={}){
  const source=await openWavChunkSource(file,{signal});
  const meta=source.info;
  if(meta.channels>2||meta.frames<1)throw RangeError("モノラルまたはステレオの空でないWAVが必要です");
  const outFrames=Math.max(1,Math.round(meta.frames*sampleRate/meta.sampleRate));
  checkPCMBudget(4*meta.channels*(meta.sampleRate===sampleRate?meta.frames:2*meta.frames+2*outFrames),maxBytes);
  const channels=Array.from({length:meta.channels},()=>new Float32Array(meta.frames));
  for await(const part of source.iterateFrames({signal}))
    for(let c=0;c<channels.length;c++)channels[c].set(part.channels[c],part.start);
  if(signal?.aborted)throw Error("読込中断");
  if(!channels.every(ch=>ch.every(Number.isFinite)))throw RangeError("無効なPCM");
  if(meta.sampleRate===sampleRate)return {sampleRate,origin:0,channels,originalSampleRate:meta.sampleRate};
  const ctx=new OfflineAudioContext(meta.channels,outFrames,sampleRate);
  const buffer=ctx.createBuffer(meta.channels,meta.frames,meta.sampleRate);
  channels.forEach((c,i)=>buffer.copyToChannel(c,i));
  const node=ctx.createBufferSource();node.buffer=buffer;node.connect(ctx.destination);node.start();
  const output=await ctx.startRendering();
  if(signal?.aborted)throw Error("読込中断");
  return {sampleRate,origin:0,originalSampleRate:meta.sampleRate,channels:Array.from({length:meta.channels},(_,i)=>Float32Array.from(output.getChannelData(i)))};
}

// Uncompressed WAV keeps the shared bounded reader; compressed formats use
// the browser's native decoder, as in the comparison prototype.
export async function readLocalAudio(file,{sampleRate=SAMPLE_RATE,maxBytes=DEFAULT_PCM_BUDGET_BYTES,signal,Context=globalThis.OfflineAudioContext}={}){
  if(!file||!Number.isSafeInteger(file.size)||file.size<1)throw RangeError("空の音声ファイル");
  if(signal?.aborted)throw Error("読込中断");
  const header=new Uint8Array(await file.slice(0,12).arrayBuffer());
  const tag=(offset)=>String.fromCharCode(...header.subarray(offset,offset+4));
  if(signal?.aborted)throw Error("読込中断");
  if((tag(0)==="RIFF"&&tag(8)==="WAVE")||/\.wav$/i.test(file.name??"")||file.type==="audio/wav")
    return readLocalWav(file,{sampleRate,maxBytes,signal});
  checkPCMBudget(file.size,maxBytes);
  if(typeof Context!=="function")throw Error("ブラウザの音声デコーダが利用できません");
  const bytes=await file.arrayBuffer();
  if(signal?.aborted)throw Error("読込中断");
  const ctx=new Context(1,1,sampleRate);
  let decoded;
  try{decoded=await ctx.decodeAudioData(bytes);}
  catch{throw Error("音声をデコードできません（形式非対応またはファイル破損）");}
  if(signal?.aborted)throw Error("読込中断");
  if(![1,2].includes(decoded.numberOfChannels)||decoded.length<1)throw RangeError("モノラルまたはステレオの空でない音声が必要です");
  // Native decoder allocations happen before the decoded size is known.
  // This bounds retained/copy PCM, not the browser's internal allocations.
  checkPCMBudget(file.size+8*decoded.numberOfChannels*decoded.length,maxBytes);
  const result={sampleRate:decoded.sampleRate,origin:0,channels:Array.from({length:decoded.numberOfChannels},(_,i)=>Float32Array.from(decoded.getChannelData(i)))};
  validatePCM(result);
  return result;
}
