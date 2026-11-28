import {validatePCM} from "./convolution.mjs";
import {extractIRWindow} from "./ir-window.mjs";
import {createComparisonTimeline,createModeOutputContract} from "./comparison-timeline.mjs";

const PROGRESSIVE_MODES=new Set(["dry","normal","ir-window"]);
const PREVIEW_REQUESTED_GAIN=.25;
const PREVIEW_CEILING=.9;

function peakConvolutionBound(channels){
  let peak=0;
  for(const channel of channels){
    let sum=0;
    for(const sample of channel)sum+=Math.abs(sample);
    peak=Math.max(peak,sum);
  }
  return peak;
}

export function createProgressiveSession(source,ir,{predelay=0,
  irWindowSettings={start:0,duration:.1,calibration:"natural"},processingRate=ir?.sampleRate}={}){
  if(!source||typeof source.read!=="function"||
     !Number.isSafeInteger(source.sourceFrames)||source.sourceFrames<1||
     ![1,2].includes(source.channelCount)||!Number.isFinite(source.sampleRate)||source.sampleRate<=0)
    throw new TypeError("逐次読込音源が不正です");
  const kernel=validatePCM(ir);
  if(kernel.origin!==0||!Number.isFinite(predelay)||!Number.isFinite(processingRate)||processingRate<=0)
    throw new RangeError("IRまたはPredelayが不正です");
  const window=extractIRWindow(kernel,irWindowSettings);
  const delayFrames=Math.round(Math.max(0,predelay)*source.sampleRate);
  const irFramesAtSourceRate=Math.max(1,Math.round(kernel.channels[0].length*source.sampleRate/kernel.sampleRate));
  const wetOutputFrames=source.sourceFrames+delayFrames+irFramesAtSourceRate-1;
  // Normalized decoded PCM is bounded by one. The shared native preview gain
  // also caps at 0.25; L1 bounds convolution without decoding the whole source.
  const rateScale=processingRate/kernel.sampleRate;
  const peak=Math.max(1,peakConvolutionBound(kernel.channels)*rateScale,
    peakConvolutionBound(window.channels)*rateScale);
  const gain={applied:Math.min(PREVIEW_REQUESTED_GAIN,PREVIEW_CEILING/peak),
    peak,ceiling:PREVIEW_CEILING};
  const length=source.sourceFrames,sampleRate=source.sampleRate;
  const interval={start:0,end:length};
  function outputFor(mode,{sourceRevision=0,irRevision=0,mixRevision=0}={}){
    if(!["dry","normal","reverse","ir-window","wet-buffer"].includes(mode))
      throw new RangeError("方式別出力契約が未定義です");
    const selectedKernel=mode==="ir-window"?window:kernel;
    const selectedIRFrames=Math.max(1,Math.round(selectedKernel.channels[0].length*sampleRate/selectedKernel.sampleRate));
    const selectedDelay=Math.round(Math.max(0,predelay)*sampleRate);
    const outputInterval=mode==="reverse"?
      {start:selectedDelay-(selectedIRFrames-1),end:length+selectedDelay}:
      mode==="dry"?interval:{start:0,end:length+selectedDelay+selectedIRFrames-1};
    const timeline=createComparisonTimeline({interval:outputInterval,sampleRate});
    return createModeOutputContract({mode,timeline,sourceFrames:length,sourceSampleRate:sampleRate,
      irFrames:selectedIRFrames,delayFrames:selectedDelay,sourceRevision,irRevision,mixRevision});
  }
  return Object.freeze({
    progressive:true,source,ir:kernel,length,sampleRate,processingRate,
    interval,timeline:createComparisonTimeline({interval,sampleRate}),wetOutputFrames,irFrames:kernel.channels[0].length,irSampleRate:kernel.sampleRate,
    irWindow:window.range,irCalibration:window.calibration,irScale:window.scale,
    gain,outputFor,
    async withIRWindow(settings){return createProgressiveSession(source,kernel,{predelay,irWindowSettings:settings,processingRate});},
    withProcessingRate(rate){return createProgressiveSession(source,kernel,{predelay,irWindowSettings,processingRate:rate});},
    select(mode,mix=.25,solo="mix"){
      if(!PROGRESSIVE_MODES.has(mode))throw Error("この長尺音源ではDry/Normal以外の比較準備は未対応です");
      if(!Number.isFinite(mix)||mix<0||mix>1||!["mix","dry","wet"].includes(solo))
        throw new RangeError("無効な試聴比率");
      return {source,sourceFrames:length,wetOutputFrames,sampleRate,mode,
        output:outputFor(mode),
        ir:mode==="ir-window"?window:kernel,mix,solo,predelay};
    }
  });
}
