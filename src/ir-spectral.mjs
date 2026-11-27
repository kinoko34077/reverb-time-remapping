import {createSpectralTimePitch} from "../shared/atf/source-spectral.mjs";
import {createSourceTimeline,validatePlaybackSpeed} from "../shared/atf/source-timeline.mjs";
import {validatePCM,checkPCMBudget,DEFAULT_PCM_BUDGET_BYTES,renderConvolution} from "./convolution.mjs";

// R4a: finite kernel generation, not a Wet-cache effect and not the
// per-excitation age clock. Reuse complex STFT/phase and original context.
export function renderIRSpectral(ir,settings={}){
  const h=validatePCM(ir);
  if(h.origin!==0)throw RangeError("IR must use zero-based age");
  const {startFrame=0,speed=1,outputFrames=h.length,boundary="zero",
    loopStartFrame=0,loopEndFrame=h.length,fftFrames=2048,hopFrames=256,
    phaseLock=true,maxBytes=DEFAULT_PCM_BUDGET_BYTES}=settings;
  validatePlaybackSpeed(speed);
  if(!Number.isSafeInteger(outputFrames)||outputFrames<1||
     !Number.isSafeInteger(startFrame)||startFrame<0||startFrame>=h.length||
     !["zero","repeat"].includes(boundary))throw RangeError("invalid finite IR trajectory");
  if(!Number.isSafeInteger(loopStartFrame)||!Number.isSafeInteger(loopEndFrame)||
     loopStartFrame<0||loopStartFrame>=loopEndFrame||loopEndFrame>h.length)
    throw RangeError("invalid IR repeat interval");
  if(boundary==="repeat"&&(startFrame<loopStartFrame||startFrame>=loopEndFrame))
    throw RangeError("IR start outside repeat interval");
  if(![1024,2048,4096,8192].includes(fftFrames)||!Number.isInteger(hopFrames)||
    hopFrames<1||fftFrames%hopFrames!==0||hopFrames>fftFrames/4||typeof phaseLock!=="boolean")
    throw RangeError("invalid spectral IR settings");
  const channelsCount=h.channels.length;
  // Estimate input/output and spectral working arrays, not an engine-wide
  // memory guarantee. An infinite fixed kernel is never allocated.
  checkPCMBudget(4*channelsCount*(h.length+outputFrames)+
    8*fftFrames*(channelsCount*12+16),maxBytes);
  const channels=h.channels.map(()=>new Float32Array(outputFrames));
  const clock=createSourceTimeline({sourceFrames:h.length,sourceSampleRate:h.sampleRate,
    outputSampleRate:h.sampleRate,startFrame,speed,loopStartFrame,loopEndFrame,
    loopEnabled:boundary==="repeat"});
  let renderedFrames=0;
  let algorithm="exact-raw";
  // Identity at ordinary forward scan is a numerical requirement, not a
  // claim that phase-vocoder reconstruction is exact at all speeds.
  if(speed===1&&boundary==="zero"){
    renderedFrames=Math.min(outputFrames,h.length-startFrame);
    for(let ch=0;ch<channelsCount;ch++)
      channels[ch].set(h.channels[ch].subarray(startFrame,startFrame+renderedFrames));
    clock.advance(renderedFrames);
  }else{
    const synth=createSpectralTimePitch({sourceSampleRate:h.sampleRate,outputSampleRate:h.sampleRate,
      channelCount:channelsCount,fftFrames,hopFrames,phaseLock});
    algorithm=synth.state.algorithm;
    const read=(ch,index)=>h.channels[ch][index];
    // The shared synth reads the original complex local context. The age
    // clock is finite and separate from the carrier output time.
    while(renderedFrames<outputFrames){
      if(clock.sourceFrameAt(0)===null)break;
      let count=Math.min(128,outputFrames-renderedFrames);
      if(boundary==="zero"&&clock.sourceFrameAt(count-1)===null){
        // Last partial block: only valid center positions are synthesized.
        let lo=1,hi=count;
        while(lo<hi){const mid=Math.ceil((lo+hi)/2);
          if(clock.sourceFrameAt(mid-1)===null)hi=mid-1;else lo=mid;}
        count=lo;
      }
      const views=channels.map(c=>c.subarray(renderedFrames,renderedFrames+count));
      const result=synth.render(views,clock.state,read,h.length);
      if(result.missingFrames!==0)throw Error("IR PCM context missing");
      clock.advance(count);renderedFrames+=count;
    }
  }
  if(!channels.every(c=>c.every(Number.isFinite)))throw Error("nonfinite spectral IR");
  return {origin:0,sampleRate:h.sampleRate,channels,trajectory:{
    startFrame,speed,boundary,loopStartFrame,loopEndFrame,outputFrames,renderedFrames,
    endFrame:clock.state.sourceFrame,algorithm,fftFrames,hopFrames,phaseLock}};
}

export async function renderSpectralWet(input,ir,settings={},convolutionOptions={}){
  const kernel=renderIRSpectral(ir,settings);
  const wet=await renderConvolution(input,kernel,convolutionOptions);
  return {kernel,wet};
}
