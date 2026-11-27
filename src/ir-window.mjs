import {secondsToFrames} from "./convolution.mjs";

// Select an IR age interval, then move its first sample to age zero. Do not
// normalize the selected portion: late-window decay must remain audible.
export function extractIRWindow(ir,{start=0,duration=.1,calibration="natural"}={}){
  const {sampleRate,channels,origin=0}=ir;
  if(origin!==0||!Array.isArray(channels)||![1,2].includes(channels.length)||
    !channels.every(c=>c instanceof Float32Array&&c.length===channels[0].length))
    throw RangeError("IRのチャンネルまたは座標が不正です");
  if(!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0)
    throw RangeError("IR窓の開始・長さが不正です");
  const first=secondsToFrames(start,sampleRate),count=secondsToFrames(duration,sampleRate);
  const total=channels[0].length;
  if(first>=total||count<1)throw RangeError("IR窓が範囲外です");
  const end=first+Math.min(count,total-first);
  if(!["natural","compensated"].includes(calibration))throw RangeError("IR補正方式が不正です");
  const window=channels.map(c=>c.slice(first,end));
  let scale=1;
  if(calibration==="compensated"){
    const rms=parts=>{
      let sum=0,n=0;for(const channel of parts)for(const v of channel){sum+=v*v;n++;}
      return Math.sqrt(sum/n);
    };
    const local=rms(window),full=rms(channels);
    // A single coefficient for all channels; silent sections remain silent.
    // Cap gain to avoid arbitrarily boosting numerical noise.
    if(local>0)scale=Math.min(8,full/local);
    if(!Number.isFinite(scale))throw RangeError("IR補正係数が不正です");
    for(const channel of window)for(let i=0;i<channel.length;i++)channel[i]*=scale;
  }
  return {sampleRate,origin:0,channels:window,calibration,scale,
    range:{startFrame:first,endFrame:end,requestedFrames:count,truncated:end-first<count}};
}
