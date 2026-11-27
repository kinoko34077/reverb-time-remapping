import {renderConvolution,comparisonInterval,alignPCM,mixAligned,previewGain,secondsToFrames,DEFAULT_PCM_BUDGET_BYTES} from "./convolution.mjs";
import {extractIRWindow} from "./ir-window.mjs";
export const MODES=["dry","normal","reverse","ir-window","wet-buffer","wet-spectral"];
export async function prepareComparison(input,ir,{predelay=0,maxBytes=DEFAULT_PCM_BUDGET_BYTES,renderMono,irWindow}={}){
  const delay=secondsToFrames(predelay,input.sampleRate);
  const interval=comparisonInterval(input,ir,delay),count=Math.max(input.channels.length,ir.channels.length);
  const length=interval.end-interval.start;
  // Account for retained aligned signals, one mixed buffer, bridge window and
  // unaligned render outputs; native internal working memory is additional.
  const reserve=4*count*length*6;
  if(!Number.isSafeInteger(reserve)||reserve>=maxBytes)throw RangeError("比較区間がPCM予算を超えています");
  const opts={delay,maxBytes:maxBytes-reserve,...(renderMono?{renderMono}:{})};
  const dry=alignPCM(input,{...interval,channelCount:count,maxBytes});
  const normal=alignPCM(await renderConvolution(input,ir,opts),{...interval,channelCount:count,maxBytes});
  const reverse=alignPCM(await renderConvolution(input,ir,{...opts,reverse:true}),{...interval,channelCount:count,maxBytes});
  const kernel=extractIRWindow(ir,irWindow);
  const partial=alignPCM(await renderConvolution(input,kernel,opts),{...interval,channelCount:count,maxBytes});
  const signals={dry,normal,reverse,"ir-window":partial};
  const gain=previewGain(Object.values(signals),.25,.9);
  return Object.freeze({signals,interval,sampleRate:input.sampleRate,length,gain,irWindow:kernel.range,
    select(mode,wet=.5,solo="mix"){
      if(!MODES.includes(mode)||!["mix","dry","wet"].includes(solo))throw RangeError("未知の比較方式");
      if(mode==="wet-buffer"||mode==="wet-spectral")throw Error("独立Wet再生経路が必要です");
      if(mode==="dry"||solo==="dry")return dry;
      if(solo==="wet")return signals[mode];
      return mixAligned(dry,signals[mode],wet,{maxBytes});
    }});
}
