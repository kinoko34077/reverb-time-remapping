// A comparison's local player frame is an index into a signed shared interval.
// Keep this conversion in one place so modes with pre-source output (Reverse)
// do not get mistaken for Source-relative timelines.
export function createComparisonTimeline({interval,sampleRate}={}){
  const {start,end}=interval??{};
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||
     !Number.isFinite(sampleRate)||sampleRate<=0)
    throw new RangeError("比較時間軸が不正です");
  const length=end-start;
  if(!Number.isSafeInteger(length))throw new RangeError("比較時間軸が安全な長さを超えています");
  const frameAtTime=time=>{
    if(!Number.isFinite(time))throw new RangeError("比較時刻が不正です");
    return Math.round(time*sampleRate)-start;
  };
  const timeAtFrame=frame=>{
    if(!Number.isFinite(frame))throw new RangeError("比較frameが不正です");
    return (start+frame)/sampleRate;
  };
  const clampFrame=frame=>Math.min(length,Math.max(0,Math.round(frame)));
  return Object.freeze({start,end,sampleRate,length,frameAtTime,timeAtFrame,clampFrame});
}

// Describe the input ranges needed to render a mode-local output window.
// `delayFrames` and `irFrames` use the timeline's processing sample rate;
// source reads are converted back to the source's native frame clock.
export function createModeOutputContract({mode,timeline,sourceFrames,sourceSampleRate=timeline?.sampleRate,
  sourceOrigin=0,irFrames,delayFrames=0,sourceRevision=0,irRevision=0,mixRevision=0}={}){
  if(!mode||!timeline||!Number.isSafeInteger(sourceFrames)||sourceFrames<1||
     !Number.isFinite(sourceSampleRate)||sourceSampleRate<=0||!Number.isSafeInteger(sourceOrigin)||
     !Number.isSafeInteger(irFrames)||irFrames<1||!Number.isSafeInteger(delayFrames)||
     !Number.isSafeInteger(sourceRevision)||sourceRevision<0||
     !Number.isSafeInteger(irRevision)||irRevision<0||
     !Number.isSafeInteger(mixRevision)||mixRevision<0)
    throw new RangeError("方式別出力契約が不正です");
  const ratio=sourceSampleRate/timeline.sampleRate;
  function requiredSourceRange(startFrame,frameCount){
    if(!Number.isSafeInteger(startFrame)||startFrame<0||!Number.isSafeInteger(frameCount)||frameCount<1||
       startFrame+frameCount>timeline.length)
      throw new RangeError("出力範囲が方式別時間軸の範囲外です");
    const start=timeline.start+startFrame,end=start+frameCount;
    let sourceStart,sourceEnd;
    if(mode==="reverse"){
      // Reverse convolution is non-causal in the shared comparison time:
      // output depends on source at this time and up to IR-length ahead.
      sourceStart=start-delayFrames;
      sourceEnd=end-delayFrames+irFrames-1;
    }else if(mode==="normal"||mode==="ir-window"||mode==="wet-buffer"){
      sourceStart=start-delayFrames-(irFrames-1);
      sourceEnd=end-delayFrames;
    }else if(mode==="dry"){
      sourceStart=start;sourceEnd=end;
    }else{
      throw new RangeError("この方式のSource範囲写像は未定義です");
    }
    const sourceEndFrame=sourceOrigin+sourceFrames/ratio;
    const clamp=value=>Math.min(sourceEndFrame,Math.max(sourceOrigin,value));
    const toSourceFrame=value=>Math.max(0,Math.min(sourceFrames,value));
    return Object.freeze({start:toSourceFrame(Math.floor((clamp(sourceStart)-sourceOrigin)*ratio)),
      end:toSourceFrame(Math.ceil((clamp(sourceEnd)-sourceOrigin)*ratio)),lookaheadFrames:mode==="reverse"?irFrames-1:0,
      tailFrames:mode==="reverse"?0:irFrames-1});
  }
  return Object.freeze({mode,timeline,sourceFrames,sourceSampleRate,irFrames,delayFrames,
    sourceRevision,irRevision,mixRevision,requiredSourceRange});
}
