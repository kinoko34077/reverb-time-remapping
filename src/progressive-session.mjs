import {validatePCM} from "./convolution.mjs";
import {extractIRWindow} from "./ir-window.mjs";
import {createComparisonTimeline,createModeOutputContract} from "./comparison-timeline.mjs";
import {createProgressiveReversePCMReader} from "./progressive-reverse-reader.mjs";
import {validateCalibration,pcmRMS,rmsCorrection} from "./level-calibration.mjs";

const PROGRESSIVE_MODES=new Set(["dry","normal","reverse","ir-window","ir-spectral"]);
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
  irWindowSettings={start:0,duration:.1,calibration:"natural"},processingRate=ir?.sampleRate,
  reverseReaderOptions={},renderedIR=null,irSpectralCalibration="natural",irSpectralScale=1}={}){
  if(!source||typeof source.read!=="function"||
     !Number.isSafeInteger(source.sourceFrames)||source.sourceFrames<1||
     ![1,2].includes(source.channelCount)||!Number.isFinite(source.sampleRate)||source.sampleRate<=0)
    throw new TypeError("逐次読込音源が不正です");
  const kernel=validatePCM(ir);
  const spectralKernel=renderedIR?{...validatePCM(renderedIR),trajectory:renderedIR.trajectory}:null;
  if(kernel.origin!==0||!Number.isFinite(predelay)||!Number.isFinite(processingRate)||processingRate<=0)
    throw new RangeError("IRまたはPredelayが不正です");
  if(spectralKernel&&(spectralKernel.origin!==0||spectralKernel.sampleRate!==kernel.sampleRate||
    spectralKernel.channels.length!==kernel.channels.length||!spectralKernel.trajectory||
    spectralKernel.trajectory.outputFrames!==spectralKernel.length))
    throw new RangeError("再合成IRの座標またはchが不正です");
  const window=extractIRWindow(kernel,irWindowSettings);
  const delayFrames=Math.round(Math.max(0,predelay)*source.sampleRate);
  const irFramesAtSourceRate=Math.max(1,Math.round(kernel.channels[0].length*source.sampleRate/kernel.sampleRate));
  const wetOutputFrames=source.sourceFrames+delayFrames+irFramesAtSourceRate-1;
  // Normalized decoded PCM is bounded by one. The shared native preview gain
  // also caps at 0.25; L1 bounds convolution without decoding the whole source.
  const rateScale=processingRate/kernel.sampleRate;
  const peak=Math.max(1,peakConvolutionBound(kernel.channels)*rateScale,
    peakConvolutionBound(window.channels)*rateScale,
    spectralKernel?peakConvolutionBound(spectralKernel.channels)*rateScale:0);
  const gain={applied:Math.min(PREVIEW_REQUESTED_GAIN,PREVIEW_CEILING/peak),
    peak,ceiling:PREVIEW_CEILING};
  const length=source.sourceFrames,sampleRate=source.sampleRate;
  const interval={start:0,end:length};
  const reverseDelayFrames=Math.round(predelay*sampleRate);
  const reverseIRFrames=Math.max(1,Math.round(kernel.channels[0].length*sampleRate/kernel.sampleRate));
  const reverseInterval={start:Math.min(0,reverseDelayFrames-(reverseIRFrames-1)),
    end:Math.max(length,length+reverseDelayFrames)};
  const reverseTimeline=createComparisonTimeline({interval:reverseInterval,sampleRate});
  const outputReaders=new Map();
  function outputFor(mode,{sourceRevision=0,irRevision=0,mixRevision=0}={}){
    if(!["dry","normal","reverse","ir-window","wet-buffer","ir-spectral"].includes(mode))
      throw new RangeError("方式別出力契約が未定義です");
    if(mode==="ir-spectral"&&!spectralKernel)throw new Error("IR Spectral kernel is not prepared");
    const selectedKernel=mode==="ir-window"?window:mode==="ir-spectral"?spectralKernel:kernel;
    const selectedIRFrames=Math.max(1,Math.round(selectedKernel.channels[0].length*sampleRate/selectedKernel.sampleRate));
    const selectedDelay=mode==="reverse"?reverseDelayFrames:Math.round(Math.max(0,predelay)*sampleRate);
    const outputInterval=mode==="reverse"?reverseInterval:
      mode==="dry"?interval:{start:0,end:length+selectedDelay+selectedIRFrames-1};
    const timeline=createComparisonTimeline({interval:outputInterval,sampleRate});
    return createModeOutputContract({mode,timeline,sourceFrames:length,sourceSampleRate:sampleRate,
      irFrames:selectedIRFrames,delayFrames:selectedDelay,sourceRevision,irRevision,mixRevision});
  }
  return Object.freeze({
    progressive:true,source,ir:kernel,length,sampleRate,processingRate,
    interval,timeline:createComparisonTimeline({interval,sampleRate}),wetOutputFrames,irFrames:kernel.channels[0].length,irSampleRate:kernel.sampleRate,
    irWindow:window.range,irCalibration:window.calibration,irScale:window.scale,
    irSpectral:spectralKernel?.trajectory??null,irSpectralCalibration,irSpectralScale,
    gain,outputFor,
    async withIRWindow(settings){return createProgressiveSession(source,kernel,{predelay,irWindowSettings:settings,processingRate,reverseReaderOptions,
      renderedIR:spectralKernel,irSpectralCalibration,irSpectralScale});},
    async withIRSpectral(settings={},renderKernel){
      if(typeof renderKernel!=="function")throw new TypeError("IR Spectral renderer is required");
      const outputFrames=settings.outputFrames??kernel.channels[0].length;
      if(!Number.isSafeInteger(outputFrames)||outputFrames<1)throw RangeError("再合成長は正の有限サンプル数にしてください");
      const renderedResult=await renderKernel(kernel,{...settings,outputFrames});
      const trajectory=renderedResult?.trajectory;
      const rendered={...validatePCM(renderedResult),trajectory};
      if(rendered.origin!==0||rendered.sampleRate!==kernel.sampleRate||rendered.length!==outputFrames||
         rendered.channels.length!==kernel.channels.length||!rendered.trajectory||rendered.trajectory.outputFrames!==outputFrames)
        throw Error("再合成IRの座標が不正です");
      const calibration=validateCalibration(settings.calibration??"natural");
      const scale=calibration==="compensated"?
        rmsCorrection(pcmRMS(kernel.channels),pcmRMS(rendered.channels)):1;
      const calibrated=scale===1?rendered:{...rendered,channels:rendered.channels.map(c=>Float32Array.from(c,v=>v*scale))};
      return createProgressiveSession(source,kernel,{predelay,irWindowSettings,processingRate,reverseReaderOptions,
        renderedIR:calibrated,irSpectralCalibration:calibration,irSpectralScale:scale});
    },
    withProcessingRate(rate){return createProgressiveSession(source,kernel,{predelay,irWindowSettings,processingRate:rate,reverseReaderOptions,
      renderedIR:spectralKernel,irSpectralCalibration,irSpectralScale});},
    async select(mode,mix=.25,solo="mix"){
    if(!PROGRESSIVE_MODES.has(mode)&&mode!=="reverse")throw Error("この長尺音源では選択方式の比較準備は未対応です");
      if(!Number.isFinite(mix)||mix<0||mix>1||!["mix","dry","wet"].includes(solo))
        throw new RangeError("無効な試聴比率");
      if(mode==="reverse"){
        let reader=outputReaders.get(mode);
        if(!reader){reader=await createProgressiveReversePCMReader(source,kernel,outputFor(mode),
          {...reverseReaderOptions,processingRate});outputReaders.set(mode,reader);}
        reader.setMix(mix,solo);
        return {source:reader,sourceFrames:reverseTimeline.length,wetOutputFrames:reverseTimeline.length,
          sampleRate,mode,output:outputFor(mode),ir:kernel,mix,solo,predelay};
      }
      if(mode==="ir-spectral"){
        if(!spectralKernel)throw Error("IR Spectral kernel is not prepared");
        // The remapped IR is a finite kernel; the existing Normal graph streams
        // the full Source through it without materializing the Source PCM.
        return {source,sourceFrames:length,wetOutputFrames:length+delayFrames+spectralKernel.length-1,
          sampleRate,mode:"normal",output:outputFor(mode),ir:spectralKernel,mix,solo,predelay};
      }
      return {source,sourceFrames:length,wetOutputFrames, sampleRate,mode,
        output:outputFor(mode),
        ir:mode==="ir-window"?window:kernel,mix,solo,predelay};
    },
    dispose(){for(const reader of outputReaders.values())reader.dispose();outputReaders.clear();}
  });
}
