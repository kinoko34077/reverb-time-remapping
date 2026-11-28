import {createLiveConvolutionGraph} from "./live-convolution.mjs";
import {validatePCM} from "./convolution.mjs";

export async function matchKernelSampleRate(ctx,kernel,{Context=globalThis.OfflineAudioContext}={}){
  const ir=validatePCM(kernel);
  if(ir.sampleRate===ctx.sampleRate)return ir;
  if(typeof Context!=="function")throw Error("IRのサンプルレート変換が利用できません");
  const frames=Math.max(1,Math.round(ir.channels[0].length*ctx.sampleRate/ir.sampleRate));
  const offline=new Context(ir.channels.length,frames,ctx.sampleRate);
  const input=offline.createBuffer(ir.channels.length,ir.channels[0].length,ir.sampleRate);
  ir.channels.forEach((channel,index)=>input.copyToChannel(channel,index));
  const source=offline.createBufferSource();source.buffer=input;source.connect(offline.destination);source.start();
  const rendered=await offline.startRendering();
  // An IR is a sampled convolution kernel, not an audio playback source.
  // Preserve its continuous-time area when the processing clock changes.
  const amplitudeScale=ctx.sampleRate/ir.sampleRate;
  return {origin:0,sampleRate:ctx.sampleRate,
    channels:Array.from({length:ir.channels.length},(_,index)=>
      Float32Array.from(rendered.getChannelData(index),sample=>sample*amplitudeScale))};
}

export async function renderConvolutionHistory(ctx,source,kernel,targetFrame,{predelaySeconds=0,
  Context=globalThis.OfflineAudioContext}={}){
  const ir=validatePCM(kernel);
  if(!source||typeof source.read!=="function"||
     !Number.isSafeInteger(source.sourceFrames)||!Number.isInteger(source.channelCount)||
     ![1,2].includes(source.channelCount)||!Number.isFinite(source.sampleRate)||source.sampleRate<=0||
     !Number.isSafeInteger(targetFrame)||targetFrame<0||targetFrame>source.sourceFrames||
     !Number.isFinite(predelaySeconds)||predelaySeconds<0||predelaySeconds>60||
     ir.sampleRate!==ctx.sampleRate)
    throw new RangeError("畳み込み履歴の素材・座標が不正です");
  const delayFrames=Math.round(predelaySeconds*ctx.sampleRate);
  const tailFrames=ir.channels[0].length-1+delayFrames;
  if(targetFrame===0||tailFrames===0)return null;
  // The entire IR tail plus predelay is measured on the processing clock.
  // Convert that duration to source frames, rather than converting only the
  // predelay; the source can run at a different rate from the AudioContext.
  const historyFrames=Math.min(targetFrame,Math.ceil(tailFrames*source.sampleRate/ctx.sampleRate));
  if(historyFrames<1)return null;
  const startFrame=targetFrame-historyFrames;
  const history=Array.from({length:source.channelCount},()=>new Float32Array(historyFrames));
  const blockLimit=Math.max(1,source.maxReadFrames??source.windowFrames??65_536);
  for(let offset=0;offset<historyFrames;){
    const count=Math.min(blockLimit,historyFrames-offset);
    const range=await source.read(startFrame+offset,count,{priority:"playback"});
    if(range?.startFrame!==startFrame+offset||range.channels?.length!==history.length||
       !range.channels.every(channel=>channel instanceof Float32Array&&channel.length===count))
      throw Error("逐次音源readerが畳み込み履歴を返しませんでした");
    range.channels.forEach((channel,index)=>history[index].set(channel,offset));
    offset+=count;
  }
  const historyOutputFrames=Math.max(1,Math.round(historyFrames*ctx.sampleRate/source.sampleRate));
  const renderFrames=historyOutputFrames+tailFrames;
  if(!Number.isSafeInteger(renderFrames)||renderFrames<1||typeof Context!=="function")
    throw Error("畳み込み履歴を有限PCMへ再構成できません");
  const offline=new Context(Math.max(history.length,ir.channels.length),renderFrames,ctx.sampleRate);
  const input=offline.createBuffer(history.length,historyFrames,source.sampleRate);
  history.forEach((channel,index)=>input.copyToChannel(channel,index));
  const graph=createLiveConvolutionGraph(offline,{sourceChannels:history.length,ir,wet:1,
    predelaySeconds});
  const inputNode=offline.createBufferSource();inputNode.buffer=input;
  inputNode.connect(graph.input);graph.output.connect(offline.destination);inputNode.start();
  const rendered=await offline.startRendering();
  const channels=Array.from({length:Math.max(history.length,ir.channels.length)},(_,index)=>
    Float32Array.from(rendered.getChannelData(index).slice(historyOutputFrames,
      historyOutputFrames+tailFrames)));
  if(!channels.every(channel=>channel.every(Number.isFinite)))throw RangeError("畳み込み履歴が有限PCMではありません");
  return {startFrame:targetFrame,sampleRate:ctx.sampleRate,channels};
}
