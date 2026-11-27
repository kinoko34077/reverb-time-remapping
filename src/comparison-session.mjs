import {renderConvolution,comparisonInterval,alignPCM,mixAligned,previewGain,secondsToFrames,validatePCM,DEFAULT_PCM_BUDGET_BYTES} from "./convolution.mjs";
import {extractIRWindow} from "./ir-window.mjs";
import {renderIRSpectral} from "./ir-spectral.mjs";
import {validateCalibration,pcmRMS,rmsCorrection} from "./level-calibration.mjs";
export const MODES=["dry","normal","reverse","ir-window","wet-buffer","wet-spectral","ir-spectral"];
export async function prepareComparison(input,ir,{predelay=0,maxBytes=DEFAULT_PCM_BUDGET_BYTES,renderMono,irWindow}={}){
  const delay=secondsToFrames(predelay,input.sampleRate);
  const interval=comparisonInterval(input,ir,delay),count=Math.max(input.channels.length,ir.channels.length);
  const length=interval.end-interval.start,irFrames=ir.channels[0].length;
  // Additional aligned spectral cache and worker IR copy are accounted for.
  const reserve=4*count*length*10;
  if(!Number.isSafeInteger(reserve)||reserve>=maxBytes)throw RangeError("比較区間がPCM予算を超えています");
  const opts={delay,maxBytes:maxBytes-reserve,...(renderMono?{renderMono}:{})};
  const dry=alignPCM(input,{...interval,channelCount:count,maxBytes});
  const normal=alignPCM(await renderConvolution(input,ir,opts),{...interval,channelCount:count,maxBytes});
  const reverse=alignPCM(await renderConvolution(input,ir,{...opts,reverse:true}),{...interval,channelCount:count,maxBytes});
  const aligned=async kernel=>alignPCM(await renderConvolution(input,kernel,opts),{...interval,channelCount:count,maxBytes});
  async function prepareWindow(settings){
    const kernel=extractIRWindow(ir,settings);
    return {signal:await aligned(kernel),range:kernel.range,calibration:kernel.calibration,scale:kernel.scale};
  }
  const initialSpectral={signal:normal,calibration:"natural",scale:1,trajectory:{
    startFrame:0,speed:1,boundary:"zero",loopStartFrame:0,loopEndFrame:irFrames,
    outputFrames:irFrames,renderedFrames:irFrames,endFrame:irFrames,
    algorithm:"exact-raw",fftFrames:2048,hopFrames:256,phaseLock:true}};
  function session(window,spectral){
    const signals={dry,normal,reverse,"ir-window":window.signal,"ir-spectral":spectral.signal};
    const gain=previewGain(Object.values(signals),.25,.9);
    return Object.freeze({signals,interval,sampleRate:input.sampleRate,length,gain,irWindow:window.range,
      irFrames,irCalibration:window.calibration,irScale:window.scale,
      irSpectral:spectral.trajectory,irSpectralCalibration:spectral.calibration,irSpectralScale:spectral.scale,
      async withIRWindow(settings){return session(await prepareWindow(settings),spectral);},
      async withIRSpectral(settings={},renderKernel=renderIRSpectral){
        const outputFrames=settings.outputFrames??irFrames;
        // All seven modes retain the same finite alignment. Longer kernels
        // require expanding the comparison interval and are a separate unit.
        if(!Number.isSafeInteger(outputFrames)||outputFrames<1||outputFrames>irFrames)
          throw RangeError("再合成長は準備済みIR長以内にしてください");
        const calibration=validateCalibration(settings.calibration??"natural");
        const kernel=await renderKernel(ir,{...settings,outputFrames,maxBytes:opts.maxBytes});
        const h=validatePCM(kernel);
        if(h.origin!==0||h.sampleRate!==ir.sampleRate||h.length!==outputFrames||h.channels.length!==ir.channels.length||
           !kernel.trajectory||kernel.trajectory.outputFrames!==outputFrames)throw Error("再合成IRの座標が不正です");
        const scale=calibration==="compensated"?rmsCorrection(pcmRMS(ir.channels),pcmRMS(h.channels)):1;
        // Own the rendered kernel; never alter original IR or prior cache.
        const calibrated={...kernel,channels:scale===1?h.channels:h.channels.map(c=>Float32Array.from(c,v=>v*scale))};
        return session(window,{signal:await aligned(calibrated),calibration,scale,trajectory:kernel.trajectory});
      },
      select(mode,wet=.5,solo="mix"){
        if(!MODES.includes(mode)||!["mix","dry","wet"].includes(solo))throw RangeError("未知の比較方式");
        if(mode==="wet-buffer"||mode==="wet-spectral")throw Error("独立Wet再生経路が必要です");
        if(mode==="dry"||solo==="dry")return dry;
        if(solo==="wet")return signals[mode];
        return mixAligned(dry,signals[mode],wet,{maxBytes});
      }});
  }
  return session(await prepareWindow(irWindow),initialSpectral);
}
