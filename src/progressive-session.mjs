import {validatePCM} from "./convolution.mjs";
import {extractIRWindow} from "./ir-window.mjs";

const PROGRESSIVE_MODES=new Set(["dry","normal","ir-window"]);

export function createProgressiveSession(source,ir,{predelay=0,irWindowSettings={start:0,duration:.1,calibration:"natural"}}={}){
  if(!source||typeof source.read!=="function"||
     !Number.isSafeInteger(source.sourceFrames)||source.sourceFrames<1||
     ![1,2].includes(source.channelCount)||!Number.isFinite(source.sampleRate)||source.sampleRate<=0)
    throw new TypeError("逐次読込音源が不正です");
  const kernel=validatePCM(ir);
  if(kernel.origin!==0||!Number.isFinite(predelay))throw new RangeError("IRまたはPredelayが不正です");
  const window=extractIRWindow(kernel,irWindowSettings);
  const length=source.sourceFrames,sampleRate=source.sampleRate;
  return Object.freeze({
    progressive:true,source,ir:kernel,length,sampleRate,
    interval:{start:0,end:length},irFrames:kernel.channels[0].length,irSampleRate:kernel.sampleRate,
    irWindow:window.range,irCalibration:window.calibration,irScale:window.scale,
    gain:{applied:1,peak:null,ceiling:.9},
    async withIRWindow(settings){return createProgressiveSession(source,kernel,{predelay,irWindowSettings:settings});},
    select(mode,mix=.25,solo="mix"){
      if(!PROGRESSIVE_MODES.has(mode))throw Error("この長尺音源ではDry/Normal以外の比較準備は未対応です");
      if(!Number.isFinite(mix)||mix<0||mix>1||!["mix","dry","wet"].includes(solo))
        throw new RangeError("無効な試聴比率");
      return {source,sourceFrames:length,sampleRate,mode,ir:mode==="ir-window"?window:kernel,mix,solo,predelay};
    }
  });
}
