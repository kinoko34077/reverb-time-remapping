import {createProgressivePCMCache} from "../shared/atf/progressive-source-cache.mjs";
import {createLiveConvolutionGraph} from "./live-convolution.mjs";
import {matchKernelSampleRate} from "./progressive-convolution.mjs";
import {validatePCM} from "./convolution.mjs";

function throwIfAborted(signal){
  if(signal?.aborted){const error=Error("Reverse PCM window decode aborted");error.name="AbortError";throw error;}
}

// Render only the Reverse output windows requested by the player. The signed
// output timeline is independent from the Source reader's zero-based frames.
export async function createProgressiveReversePCMReader(source,kernel,contract,{
  windowFrames=65_536,maxCachedWindows=2,maxReadFrames=source?.maxReadFrames??windowFrames*4,
  Context=globalThis.OfflineAudioContext,renderWindow:renderOverride
}={}){
  if(!source||typeof source.read!=="function"||!Number.isSafeInteger(source.sourceFrames)||source.sourceFrames<1||
     ![1,2].includes(source.channelCount)||!Number.isFinite(source.sampleRate)||source.sampleRate<=0||
     contract?.mode!=="reverse"||contract.timeline?.sampleRate!==source.sampleRate||
     contract.sourceFrames!==source.sourceFrames)
    throw new RangeError("長尺Reverse readerの入力契約が不正です");
  const ir=validatePCM(kernel);
  if(ir.origin!==0)throw new RangeError("IRは0始点である必要があります");
  const matched=await matchKernelSampleRate({sampleRate:source.sampleRate},ir,{Context});
  const kernelFrames=matched.channels[0].length;
  if(contract.irFrames!==kernelFrames)throw new RangeError("Reverse IRと出力契約のframe数が一致しません");
  const reversed={origin:0,sampleRate:matched.sampleRate,
    channels:matched.channels.map(channel=>Float32Array.from(channel).reverse())};
  const channelCount=Math.max(source.channelCount,reversed.channels.length);

  async function render(startFrame,frameCount,{signal}={}){
    throwIfAborted(signal);
    const required=contract.requiredSourceRange(startFrame,frameCount);
    const inputFrames=required.end-required.start;
    const output=Array.from({length:channelCount},()=>new Float32Array(frameCount));
    if(inputFrames<1)return output;
    const input=Array.from({length:source.channelCount},()=>new Float32Array(inputFrames));
    for(let offset=0;offset<inputFrames;){
      throwIfAborted(signal);
      const count=Math.min(source.maxReadFrames??maxReadFrames,maxReadFrames,inputFrames-offset);
      const block=await source.read(required.start+offset,count,{priority:"playback",signal});
      if(block?.startFrame!==required.start+offset||block.channels?.length!==source.channelCount||
         !block.channels.every(channel=>channel instanceof Float32Array&&channel.length===count))
        throw Error("Reverse source readerが要求範囲のPCMを返しませんでした");
      block.channels.forEach((channel,index)=>input[index].set(channel,offset));
      offset+=count;
    }
    throwIfAborted(signal);
    const request={input,required,frameCount,outputStart:contract.timeline.start+startFrame,
      delayFrames:contract.delayFrames,kernel:matched,reversedKernel:reversed,channelCount,signal};
    let rendered;
    if(renderOverride)rendered=await renderOverride(request);
    else{
      if(typeof Context!=="function")throw Error("長尺Reverseの有限window rendererが利用できません");
      const renderFrames=inputFrames+kernelFrames-1;
      const offline=new Context(channelCount,renderFrames,source.sampleRate);
      const inputBuffer=offline.createBuffer(source.channelCount,inputFrames,source.sampleRate);
      input.forEach((channel,index)=>inputBuffer.copyToChannel(channel,index));
      const graph=createLiveConvolutionGraph(offline,{sourceChannels:source.channelCount,ir:reversed,
        wet:1,solo:"wet"});
      const node=offline.createBufferSource();node.buffer=inputBuffer;node.connect(graph.input);
      graph.output.connect(offline.destination);node.start();
      try{
        const buffer=await offline.startRendering();
        const sourceOrigin=required.start+contract.delayFrames-(kernelFrames-1);
        const offset=request.outputStart-sourceOrigin;
        rendered=Array.from({length:channelCount},(_,channel)=>{
          const result=new Float32Array(frameCount),data=buffer.getChannelData(channel);
          for(let frame=0;frame<frameCount;frame++){
            const index=offset+frame;
            if(index>=0&&index<data.length)result[frame]=data[index];
          }
          return result;
        });
      }finally{graph.dispose();node.disconnect();}
    }
    throwIfAborted(signal);
    if(!Array.isArray(rendered)||rendered.length!==channelCount||
       !rendered.every(channel=>channel instanceof Float32Array&&channel.length===frameCount&&channel.every(Number.isFinite)))
      throw Error("長尺Reverse rendererが有限PCMを返しませんでした");
    return rendered;
  }

  const cache=createProgressivePCMCache({sourceFrames:contract.timeline.length,channelCount,
    windowFrames,maxCachedWindows,maxReadFrames,decodeWindow:render});
  let mix=1,solo="wet";
  async function read(startFrame,frameCount,options){
    const wet=await cache.read(startFrame,frameCount,options);
    if(solo==="wet"||(solo==="mix"&&mix===1))return wet;
    const output=Array.from({length:channelCount},()=>new Float32Array(frameCount));
    const outputStart=contract.timeline.start+startFrame;
    const sourceStart=Math.max(0,outputStart),sourceEnd=Math.min(source.sourceFrames,outputStart+frameCount);
    let dry=null;
    if(sourceEnd>sourceStart){
      dry=Array.from({length:source.channelCount},()=>new Float32Array(sourceEnd-sourceStart));
      for(let offset=0;offset<sourceEnd-sourceStart;){
        const count=Math.min(source.maxReadFrames??maxReadFrames,maxReadFrames,sourceEnd-sourceStart-offset);
        const block=await source.read(sourceStart+offset,count,options);
        if(block?.startFrame!==sourceStart+offset||block.channels?.length!==source.channelCount||
           !block.channels.every(channel=>channel instanceof Float32Array&&channel.length===count))
          throw Error("Reverse source readerがDry範囲のPCMを返しませんでした");
        block.channels.forEach((channel,index)=>dry[index].set(channel,offset));
        offset+=count;
      }
    }
    const dryGain=solo==="dry"?1:1-mix,wetGain=solo==="dry"?0:mix;
    for(let channel=0;channel<channelCount;channel++){
      const dryChannel=source.channelCount===1?0:channel;
      for(let frame=0;frame<frameCount;frame++){
        const sourceFrame=outputStart+frame;
        const drySample=dry&&sourceFrame>=sourceStart&&sourceFrame<sourceEnd?
          dry[dryChannel][sourceFrame-sourceStart]:0;
        output[channel][frame]=drySample*dryGain+(wet.channels[channel]?.[frame]??0)*wetGain;
      }
    }
    return {startFrame,channels:output};
  }
  function setMix(value,nextSolo="mix"){
    if(!Number.isFinite(value)||value<0||value>1||!["mix","dry","wet"].includes(nextSolo))
      throw new RangeError("無効な試聴比率");
    mix=value;solo=nextSolo;
  }
  return Object.freeze({sourceFrames:contract.timeline.length,channelCount,sampleRate:source.sampleRate,
    windowFrames,maxReadFrames,read,setMix,stats:()=>cache.stats(),dispose:()=>cache.dispose()});
}
