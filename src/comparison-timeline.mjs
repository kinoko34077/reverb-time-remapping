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
