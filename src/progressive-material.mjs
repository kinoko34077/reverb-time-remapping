import {createProgressiveAudioSource} from "../shared/atf/progressive-audio-source.mjs";
import {DEFAULT_PCM_BUDGET_BYTES} from "./convolution.mjs";

const COMPARISON_RESERVE_FACTOR=10;

export function estimatePreparedComparisonBytes({sourceFrames,sourceSampleRate,sourceChannels,
  irFrames,irSampleRate=48000,irChannels,delaySeconds=0,processingRate=48000}={}){
  if(!Number.isSafeInteger(sourceFrames)||sourceFrames<1||
     !Number.isFinite(sourceSampleRate)||sourceSampleRate<=0||
     !Number.isInteger(sourceChannels)||sourceChannels<1||sourceChannels>2||
     !Number.isSafeInteger(irFrames)||irFrames<1||
     !Number.isFinite(irSampleRate)||irSampleRate<=0||
     !Number.isInteger(irChannels)||irChannels<1||irChannels>2||
     !Number.isFinite(delaySeconds)||!Number.isFinite(processingRate)||processingRate<=0)
    throw new RangeError("比較準備の素材情報が不正です");
  const inputFrames=Math.round(sourceFrames*processingRate/sourceSampleRate);
  const kernelFrames=Math.round(irFrames*processingRate/irSampleRate);
  const delay=Math.round(delaySeconds*processingRate);
  const start=Math.min(0,delay-(kernelFrames-1));
  const end=Math.max(inputFrames,inputFrames+kernelFrames-1+delay);
  const length=end-start,count=Math.max(sourceChannels,irChannels);
  const comparisonBytes=4*count*length*COMPARISON_RESERVE_FACTOR;
  const convolutionFrames=inputFrames+kernelFrames-1;
  const convolutionWorkingBytes=4*(inputFrames*sourceChannels+kernelFrames*irChannels+
    count*convolutionFrames+3*(inputFrames+kernelFrames+convolutionFrames));
  const decodedSourceBytes=4*sourceFrames*sourceChannels;
  const bytes=comparisonBytes+convolutionWorkingBytes+decodedSourceBytes;
  return {bytes,length,channelCount:count,comparisonBytes,convolutionWorkingBytes,decodedSourceBytes,
    withinBudget:Number.isSafeInteger(bytes)&&bytes<=DEFAULT_PCM_BUDGET_BYTES};
}

export async function materializeProgressiveSource(source,{sampleRate=48000,
  Context=globalThis.OfflineAudioContext,signal}={}){
  if(!source||typeof source.read!=="function"||!Number.isSafeInteger(source.sourceFrames)||
     !Number.isInteger(source.channelCount)||!Number.isFinite(source.sampleRate)||source.sampleRate<=0)
    throw new TypeError("逐次音源readerが不正です");
  if(signal?.aborted)throw new Error("読込中断");
  const channels=Array.from({length:source.channelCount},()=>new Float32Array(source.sourceFrames));
  const blockFrames=source.windowFrames??65_536;
  for(let start=0;start<source.sourceFrames;start+=blockFrames){
    if(signal?.aborted)throw new Error("読込中断");
    const count=Math.min(blockFrames,source.sourceFrames-start);
    const range=await source.read(start,count,{priority:"playback"});
    if(range?.startFrame!==start||range.channels?.length!==channels.length||
       !range.channels.every(channel=>channel instanceof Float32Array&&channel.length===count))
      throw new Error("逐次音源readerが不正なPCM範囲を返しました");
    range.channels.forEach((channel,index)=>channels[index].set(channel,start));
  }
  if(signal?.aborted)throw new Error("読込中断");
  if(source.sampleRate===sampleRate)return {origin:0,sampleRate,originalSampleRate:source.sampleRate,channels};
  if(typeof Context!=="function")throw Error("音声サンプルレート変換が利用できません");
  const outputFrames=Math.max(1,Math.round(source.sourceFrames*sampleRate/source.sampleRate));
  const context=new Context(source.channelCount,outputFrames,sampleRate);
  const input=context.createBuffer(source.channelCount,source.sourceFrames,source.sampleRate);
  channels.forEach((channel,index)=>input.copyToChannel(channel,index));
  const node=context.createBufferSource();node.buffer=input;node.connect(context.destination);node.start();
  const rendered=await context.startRendering();
  if(signal?.aborted)throw new Error("読込中断");
  const output=Array.from({length:source.channelCount},(_,index)=>
    Float32Array.from(rendered.getChannelData(index)));
  if(!output.every(channel=>channel.every(Number.isFinite)))throw new RangeError("無効なPCM");
  return {origin:0,sampleRate,originalSampleRate:source.sampleRate,channels:output};
}

export async function resamplePCM(source,sampleRate,{Context=globalThis.OfflineAudioContext}={}){
  const {channels,origin=0,originalSampleRate=source?.sampleRate}=source??{};
  if(!Array.isArray(channels)||channels.length<1||channels.length>2||
     !channels.every(channel=>channel instanceof Float32Array&&channel.length===channels[0].length)||
     channels[0].length<1||!Number.isFinite(source.sampleRate)||source.sampleRate<=0||
     !Number.isSafeInteger(origin)||!Number.isFinite(sampleRate)||sampleRate<=0)
    throw new RangeError("変換元PCMまたはサンプルレートが不正です");
  if(source.sampleRate===sampleRate)return source;
  if(typeof Context!=="function")throw Error("音声サンプルレート変換が利用できません");
  const outputFrames=Math.max(1,Math.round(channels[0].length*sampleRate/source.sampleRate));
  const context=new Context(channels.length,outputFrames,sampleRate);
  const input=context.createBuffer(channels.length,channels[0].length,source.sampleRate);
  channels.forEach((channel,index)=>input.copyToChannel(channel,index));
  const node=context.createBufferSource();node.buffer=input;node.connect(context.destination);node.start();
  const rendered=await context.startRendering();
  const output=Array.from({length:channels.length},(_,index)=>Float32Array.from(rendered.getChannelData(index)));
  if(!output.every(channel=>channel.every(Number.isFinite)))throw new RangeError("無効なPCM");
  return {origin,sampleRate,originalSampleRate,channels:output};
}

// ATF's reader intentionally caps output at two channels. Inspect the source
// first so RTR never silently discards channels from a multichannel file.
export async function openProgressiveMaterial(file,{media, ...options}={}){
  if(!file||typeof file!=="object")throw new TypeError("音源ファイルがありません");
  const api=media??await import("../shared/atf/vendor/mediabunny-1.66.1.mjs");
  const probe=new api.Input({formats:api.ALL_FORMATS,source:new api.BlobSource(file)});
  let progressiveReadable=false,metadata;
  try{
    if(!await probe.canRead())throw Error("対応していない音声形式です");
    const track=await probe.getPrimaryAudioTrack();
    if(!track)throw Error("音声トラックが見つかりません");
    const count=await track.getNumberOfChannels();
    if(![1,2].includes(count))throw RangeError("モノラルまたはステレオの音声が必要です");
    const sampleRate=await track.getSampleRate();
    const sourceStartTime=Math.max(0,await probe.getFirstTimestamp([track]));
    let endTime=await probe.getDurationFromMetadata([track]);
    if(!Number.isFinite(endTime)||endTime<=sourceStartTime)endTime=await probe.computeDuration([track]);
    const duration=endTime-sourceStartTime,sourceFrames=Math.round(duration*sampleRate);
    if(!Number.isFinite(sampleRate)||sampleRate<=0||!Number.isFinite(duration)||duration<=0||
       !Number.isSafeInteger(sourceFrames)||sourceFrames<1)
      throw Error("音声の長さ・チャンネル情報を読み取れません");
    progressiveReadable=await track.canDecode();
    metadata={fileName:file.name||"audio",duration,sourceStartTime,sourceFrames,
      sampleRate,channelCount:count,windowFrames:65_536,maxReadFrames:1_048_576};
  }finally{probe.dispose();}
  if(!progressiveReadable){
    return {...metadata,file,canReadPCM:false,stats:()=>({cachedFrames:0,windows:0}),
      read:async()=>{throw Error("このブラウザは逐次音声デコードに対応していません");},dispose(){}};
  }
  const source=await createProgressiveAudioSource(file,{...options,media:api});
  return {...source,file,canReadPCM:true};
}
