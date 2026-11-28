import {renderConvolution,comparisonInterval,alignPCM,mixAligned,previewGain,secondsToFrames,validatePCM,DEFAULT_PCM_BUDGET_BYTES} from "./convolution.mjs";
import {extractIRWindow} from "./ir-window.mjs";
import {renderIRSpectral} from "./ir-spectral.mjs";
import {validateCalibration,pcmRMS,rmsCorrection} from "./level-calibration.mjs";
import {createComparisonTimeline,createModeOutputContract} from "./comparison-timeline.mjs";
export const MODES=["dry","normal","reverse","ir-window","wet-buffer","wet-spectral","ir-spectral"];
export async function prepareComparison(input,ir,{predelay=0,maxBytes=DEFAULT_PCM_BUDGET_BYTES,renderMono,irWindow}={}){
  const delay=secondsToFrames(predelay,input.sampleRate);
  const initialInterval=comparisonInterval(input,ir,delay),count=Math.max(input.channels.length,ir.channels.length);
  const irFrames=ir.channels[0].length,sourceEnd=(input.origin??0)+input.channels[0].length;
  function optionsFor(interval){
    const length=interval.end-interval.start;
    // Old/new aligned cache, worker IR copy, selected mix and transfer windows.
    // Native internal working memory remains outside this estimate.
    const reserve=4*count*length*10;
    if(!Number.isSafeInteger(interval.end)||!Number.isSafeInteger(reserve)||reserve>=maxBytes)
      throw RangeError("比較区間がPCM予算を超えています");
    return {delay,maxBytes:maxBytes-reserve,...(renderMono?{renderMono}:{})};
  }
  const options=optionsFor(initialInterval);
  const align=(signal,interval)=>alignPCM(signal,{...interval,channelCount:count,maxBytes});
  const initial={
    dry:align(input,initialInterval),
    normal:align(await renderConvolution(input,ir,options),initialInterval),
    reverse:align(await renderConvolution(input,ir,{...options,reverse:true}),initialInterval)
  };
  const aligned=async(kernel,interval,opts)=>align(await renderConvolution(input,kernel,opts),interval);
  async function prepareWindow(settings,interval,opts){
    const kernel=extractIRWindow(ir,settings);
    return {signal:await aligned(kernel,interval,opts),range:kernel.range,calibration:kernel.calibration,scale:kernel.scale};
  }
  const initialSpectral={signal:initial.normal,calibration:"natural",scale:1,trajectory:{
    startFrame:0,speed:1,boundary:"zero",loopStartFrame:0,loopEndFrame:irFrames,
    outputFrames:irFrames,renderedFrames:irFrames,endFrame:irFrames,
    algorithm:"exact-raw",fftFrames:2048,hopFrames:256,phaseLock:true}};
  function session(window,spectral,interval,base){
    const signals={...base,"ir-window":window.signal,"ir-spectral":spectral.signal};
    const gain=previewGain(Object.values(signals),.25,.9),length=interval.end-interval.start;
    function outputFor(mode,{sourceRevision=0,irRevision=0,mixRevision=0}={}){
      if(!["dry","normal","reverse","ir-window"].includes(mode))
        throw new RangeError("方式別出力契約が未定義です");
      const selectedKernel=mode==="ir-window"?window.range.endFrame-window.range.startFrame:irFrames;
      return createModeOutputContract({mode,timeline:createComparisonTimeline({interval,sampleRate:input.sampleRate}),
        sourceFrames:input.channels[0].length,sourceOrigin:input.origin??0,
        sourceSampleRate:input.sampleRate,irFrames:selectedKernel,
        delayFrames:delay,sourceRevision,irRevision,mixRevision});
    }
    return Object.freeze({signals,interval,sampleRate:input.sampleRate,length,
      timeline:createComparisonTimeline({interval,sampleRate:input.sampleRate}),outputFor,gain,irWindow:window.range,
      irFrames,irCalibration:window.calibration,irScale:window.scale,
      irSpectral:spectral.trajectory,irSpectralCalibration:spectral.calibration,irSpectralScale:spectral.scale,
      async withIRWindow(settings){
        return session(await prepareWindow(settings,interval,optionsFor(interval)),spectral,interval,base);
      },
      async withIRSpectral(settings={},renderKernel=renderIRSpectral){
        const outputFrames=settings.outputFrames??irFrames;
        if(!Number.isSafeInteger(outputFrames)||outputFrames<1)
          throw RangeError("再合成長は正の有限サンプル数にしてください");
        // Longer kernels extend only the right edge. Never shift the shared
        // origin or discard an already accepted comparison range on shortening.
        const end=Math.max(interval.end,sourceEnd+delay+outputFrames-1);
        const target=end===interval.end?interval:{start:interval.start,end};
        const opts=optionsFor(target);
        const calibration=validateCalibration(settings.calibration??"natural");
        const kernel=await renderKernel(ir,{...settings,outputFrames,maxBytes:opts.maxBytes});
        const h=validatePCM(kernel);
        if(h.origin!==0||h.sampleRate!==ir.sampleRate||h.length!==outputFrames||h.channels.length!==ir.channels.length||
           !kernel.trajectory||kernel.trajectory.outputFrames!==outputFrames)throw Error("再合成IRの座標が不正です");
        const scale=calibration==="compensated"?rmsCorrection(pcmRMS(ir.channels),pcmRMS(h.channels)):1;
        const calibrated={...kernel,channels:scale===1?h.channels:h.channels.map(c=>Float32Array.from(c,v=>v*scale))};
        const signal=await aligned(calibrated,target,opts);
        // Pad accepted cached signals only; do not rerun normal/reverse/IR Window.
        const expanded=target===interval?base:Object.fromEntries(Object.entries(base).map(([name,pcm])=>[name,align(pcm,target)]));
        const nextWindow=target===interval?window:{...window,signal:align(window.signal,target)};
        return session(nextWindow,{signal,calibration,scale,trajectory:kernel.trajectory},target,expanded);
      },
      select(mode,wet=.5,solo="mix"){
        if(!MODES.includes(mode)||!["mix","dry","wet"].includes(solo))throw RangeError("未知の比較方式");
        if(mode==="wet-buffer"||mode==="wet-spectral")throw Error("独立Wet再生経路が必要です");
        if(mode==="dry"||solo==="dry")return base.dry;
        if(solo==="wet")return signals[mode];
        return mixAligned(base.dry,signals[mode],wet,{maxBytes});
      }});
  }
  return session(await prepareWindow(irWindow,initialInterval,options),initialSpectral,initialInterval,initial);
}
