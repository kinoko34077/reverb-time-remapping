import {validatePCM} from "./convolution.mjs";

// Keep each source/IR channel pair independent, matching the T2 reference.
// The graph does not own source transport or the destination's safety stage.
export function createLiveConvolutionGraph(ctx,{sourceChannels,ir,wet=.5,solo="mix",predelaySeconds=0}={}){
  const kernel=validatePCM(ir);
  if(![1,2].includes(sourceChannels)||kernel.origin!==0||kernel.sampleRate!==ctx.sampleRate||
     !Number.isFinite(predelaySeconds)||predelaySeconds<0||predelaySeconds>60)
    throw RangeError("音源とIRのチャンネルまたはサンプルレートが不正です");
  const count=Math.max(sourceChannels,kernel.channels.length);
  const input=ctx.createGain(),split=ctx.createChannelSplitter(sourceChannels);
  const merger=ctx.createChannelMerger(count),dry=ctx.createGain(),wetGain=ctx.createGain(),output=ctx.createGain();
  const delay=predelaySeconds?ctx.createDelay(Math.max(1,predelaySeconds+.01)):null;
  const nodes=[input,split,merger,dry,wetGain,output,...(delay?[delay]:[])];
  input.channelCount=sourceChannels;input.channelCountMode="explicit";
  input.connect(split);input.connect(dry);dry.connect(output);merger.connect(delay??wetGain);
  if(delay){delay.delayTime.value=predelaySeconds;delay.connect(wetGain);}
  wetGain.connect(output);
  for(let c=0;c<count;c++){
    const conv=ctx.createConvolver();conv.normalize=false;
    const samples=kernel.channels[kernel.channels.length===1?0:c];
    const buffer=ctx.createBuffer(1,samples.length,kernel.sampleRate);
    buffer.copyToChannel(samples,0);conv.buffer=buffer;
    split.connect(conv,sourceChannels===1?0:c,0);conv.connect(merger,0,c);nodes.push(conv);
  }
  const setMix=(value,solo="mix")=>{
    if(!Number.isFinite(value)||value<0||value>1||!["mix","dry","wet"].includes(solo))
      throw RangeError("無効な試聴比率");
    dry.gain.value=solo==="wet"?0:solo==="dry"?1:1-value;
    wetGain.gain.value=solo==="dry"?0:solo==="wet"?1:value;
  };
  try{setMix(wet,solo);}catch(error){for(const node of nodes)node.disconnect();throw error;}
  return {input,output,setMix,dispose(){for(const node of nodes)node.disconnect();}};
}
