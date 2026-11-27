import {secondsToFrames} from "./convolution.mjs";

// Select an IR age interval, then move its first sample to age zero. Do not
// normalize the selected portion: late-window decay must remain audible.
export function extractIRWindow(ir,{start=0,duration=.1}={}){
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
  return {sampleRate,origin:0,channels:channels.map(c=>c.slice(first,end)),
    range:{startFrame:first,endFrame:end,requestedFrames:count,truncated:end-first<count}};
}
