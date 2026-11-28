import {createProgressivePCMCache} from "../shared/atf/progressive-source-cache.mjs";
import {createLiveConvolutionGraph} from "./live-convolution.mjs";
import {validatePCM} from "./convolution.mjs";

function throwIfAborted(signal){
  if(signal?.aborted){
    const error=Error("PCM window decode aborted");
    error.name="AbortError";
    throw error;
  }
}

async function matchKernelRate(Context,sourceRate,kernel){
  if(kernel.sampleRate===sourceRate)return kernel;
  if(typeof Context!=="function")throw Error("IRのサンプルレート変換が利用できません");
  const frames=Math.max(1,Math.round(kernel.channels[0].length*sourceRate/kernel.sampleRate));
  const offline=new Context(kernel.channels.length,frames,sourceRate);
  const input=offline.createBuffer(kernel.channels.length,kernel.channels[0].length,kernel.sampleRate);
  kernel.channels.forEach((channel,index)=>input.copyToChannel(channel,index));
  const node=offline.createBufferSource();node.buffer=input;node.connect(offline.destination);node.start();
  const rendered=await offline.startRendering();
  const scale=sourceRate/kernel.sampleRate;
  return {origin:0,sampleRate:sourceRate,channels:Array.from({length:kernel.channels.length},(_,index)=>
    Float32Array.from(rendered.getChannelData(index),sample=>sample*scale))};
}

// Wet PCM is rendered only for requested source-time windows. The shared ATF
// cache bounds resident output PCM; the input remains the original bounded reader.
export async function createProgressiveWetPCMReader(source,kernel,{predelaySeconds=0,
  windowFrames=65_536,maxCachedWindows=2,maxReadFrames=source?.maxReadFrames??windowFrames*4,
  Context=globalThis.OfflineAudioContext}={}){
  if(!source||typeof source.read!=="function"||!Number.isSafeInteger(source.sourceFrames)||
     source.sourceFrames<1||![1,2].includes(source.channelCount)||
     !Number.isFinite(source.sampleRate)||source.sampleRate<=0||
     !Number.isFinite(predelaySeconds)||predelaySeconds<0||predelaySeconds>60)
    throw new RangeError("長尺Wet参照の素材情報またはPredelayが不正です");
  const ir=validatePCM(kernel);
  if(ir.origin!==0)throw new RangeError("IRは0始点である必要があります");
  const matched=await matchKernelRate(Context,source.sampleRate,ir);
  const channels=Math.max(source.channelCount,matched.channels.length);
  const delayFrames=Math.round(predelaySeconds*source.sampleRate);

  async function renderWindow(start,length,{signal:abortSignal}={}){
    throwIfAborted(abortSignal);
    const result=Array.from({length:channels},()=>new Float32Array(length));
    const inputStart=Math.max(0,start-delayFrames-(matched.channels[0].length-1));
    const inputEnd=Math.min(source.sourceFrames,start+length-delayFrames);
    if(inputEnd<=inputStart)return result;
    const inputChannels=Array.from({length:source.channelCount},()=>new Float32Array(inputEnd-inputStart));
    const maxSourceRead=source.maxReadFrames??windowFrames*4;
    for(let offset=0;offset<inputEnd-inputStart;){
      const count=Math.min(maxSourceRead,inputEnd-inputStart-offset);
      const read=await source.read(inputStart+offset,count,{priority:"scrub"});
      if(read?.startFrame!==inputStart+offset||read.channels?.length!==source.channelCount||
         !read.channels.every(channel=>channel instanceof Float32Array&&channel.length===count))
        throw Error("Wet参照のSource PCM範囲が不正です");
      read.channels.forEach((channel,index)=>inputChannels[index].set(channel,offset));
      offset+=count;
    }
    throwIfAborted(abortSignal);
    const renderFrames=inputChannels[0].length+matched.channels[0].length-1+delayFrames;
    if(!Number.isSafeInteger(renderFrames)||renderFrames<1)throw RangeError("Wet参照の計算範囲が不正です");
    const offline=new Context(channels,renderFrames,source.sampleRate);
    const input=offline.createBuffer(source.channelCount,inputChannels[0].length,source.sampleRate);
    inputChannels.forEach((channel,index)=>input.copyToChannel(channel,index));
    const graph=createLiveConvolutionGraph(offline,{sourceChannels:source.channelCount,ir:matched,
      wet:1,solo:"wet",predelaySeconds});
    const node=offline.createBufferSource();node.buffer=input;node.connect(graph.input);graph.output.connect(offline.destination);node.start();
    try{
      const rendered=await offline.startRendering();
      throwIfAborted(abortSignal);
      const offset=start-inputStart;
      for(let channel=0;channel<channels;channel++){
        const data=rendered.getChannelData(channel);
        for(let frame=0;frame<length;frame++){
          const value=offset+frame<data.length?data[offset+frame]:0;
          if(!Number.isFinite(value))throw RangeError("Wet参照に無効なPCMがあります");
          result[channel][frame]=value;
        }
      }
      return result;
    }finally{graph.dispose();node.disconnect();}
  }

  const cache=createProgressivePCMCache({sourceFrames:source.sourceFrames,channelCount:channels,
    windowFrames,maxCachedWindows,maxReadFrames,decodeWindow:renderWindow});
  return Object.freeze({sourceFrames:source.sourceFrames,channelCount:channels,
    sampleRate:source.sampleRate,windowFrames,maxReadFrames,
    read:(startFrame,frameCount,options)=>cache.read(startFrame,frameCount,options),
    stats:()=>cache.stats(),dispose:()=>cache.dispose()});
}
