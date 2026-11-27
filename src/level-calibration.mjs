// Shared comparison-level calibration. One coefficient for all channels,
// separate from source PCM, synthesis, mix and output safety.
export const CALIBRATION_MODES=Object.freeze(["natural","compensated"]);
export const MAX_CALIBRATION_GAIN=8;
export function validateCalibration(mode){
  if(!CALIBRATION_MODES.includes(mode))throw RangeError("音量補正方式が不正です");
  return mode;
}
export function pcmRMS(channels,start=0,end=channels?.[0]?.length){
  if(!Array.isArray(channels)||!channels.length||
     !channels.every(c=>c instanceof Float32Array&&c.length===channels[0].length)||
     !Number.isSafeInteger(start)||!Number.isSafeInteger(end)||
     start<0||end<=start||end>channels[0].length)throw RangeError("RMS範囲が不正です");
  let sum=0;
  for(const c of channels)for(let i=start;i<end;i++)sum+=c[i]*c[i];
  const result=Math.sqrt(sum/((end-start)*channels.length));
  if(!Number.isFinite(result))throw RangeError("RMS値が不正です");
  return result;
}
export function rmsCorrection(reference,local){
  if(!Number.isFinite(reference)||reference<0||!Number.isFinite(local)||local<0)
    throw RangeError("音量補正係数が不正です");
  return local===0?1:Math.min(MAX_CALIBRATION_GAIN,reference/local);
}
export function createLocalRMSCalibration(channels,windowFrames){
  const reference=pcmRMS(channels),length=channels[0].length;
  if(!Number.isSafeInteger(windowFrames)||windowFrames<1)throw RangeError("RMS窓長が不正です");
  const width=Math.min(length,windowFrames);
  return Object.freeze({reference,windowFrames:width,scaleAt(frame,mode="natural"){
    validateCalibration(mode);
    if(!Number.isFinite(frame))throw RangeError("RMS参照位置が不正です");
    if(mode==="natural")return 1;
    const center=Math.min(length-1,Math.max(0,Math.round(frame)));
    const start=Math.min(length-width,Math.max(0,center-Math.floor(width/2)));
    return rmsCorrection(reference,pcmRMS(channels,start,start+width));
  }});
}
