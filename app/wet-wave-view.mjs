import {createPlayerWaveEditor} from "../shared/atf/player-wave-editor.mjs";

export async function readWetOverviewPeak(reader,start,end,{isCurrent=()=>true}={}){
  const maxRead=Number.isSafeInteger(reader?.maxReadFrames)&&reader.maxReadFrames>0?
    reader.maxReadFrames:32_768;
  const windowFrames=Number.isSafeInteger(reader?.windowFrames)&&reader.windowFrames>0?
    Math.min(reader.windowFrames,maxRead):maxRead;
  if(!reader||typeof reader.read!=="function"||!Number.isSafeInteger(start)||
     !Number.isSafeInteger(end)||!Number.isSafeInteger(reader.sourceFrames)||reader.sourceFrames<1||
     start<0||end<=start||end>reader.sourceFrames||
     typeof isCurrent!=="function")throw new RangeError("Wet overview range is invalid");
  let low=1,high=-1;
  for(let offset=start;offset<end;){
    if(!isCurrent())return null;
    const count=Math.min(windowFrames,end-offset);
    const range=await reader.read(offset,count,{priority:"waveform"});
    if(!isCurrent())return null;
    if(range?.startFrame!==offset||!Array.isArray(range.channels)||!range.channels.length||
       !range.channels.every(channel=>channel instanceof Float32Array&&channel.length===count))
      throw Error("Wet overview reader returned an invalid PCM range");
    for(const channel of range.channels)for(const sample of channel){
      if(!Number.isFinite(sample))throw RangeError("Wet overview contains invalid PCM");
      if(sample<low)low=sample;
      if(sample>high)high=sample;
    }
    offset+=count;
  }
  return low===1&&high===-1?[0,0]:[low,high];
}

// The waveform reads the same bounded Wet source used by playback. Wet frame
// zero is its own output origin and may extend past the Source's final frame.
export function createWetWaveView({getFrame,onSeek}){
  const $=id=>document.getElementById(id);
  const canvas=$("wet-wave-detail"),wrap=$("wet-wave-detail-wrap"),panel=$("wet-wave-panel");
  let signal=null,signalIdentity=null,waveSource=null,request=null,closed=false,
    overviewTask=null,overviewTimer=null,overviewRevision=0,overviewRetryAfter=0,overviewReady=0;
  // Matches the bounded-wide-view cutoff used by the pinned ATF editor.
  const OVERVIEW_BINS=512,DETAIL_READ_FRAMES=32_768,DETAIL_MAX_READS=64;
  const length=()=>signal?.sourceFrames??signal?.channels?.[0]?.length??0;
  const overviewLimit=()=>Math.min(DETAIL_READ_FRAMES,waveSource?.maxReadFrames??DETAIL_READ_FRAMES)*DETAIL_MAX_READS;
  const wideView=()=>Number(canvas.dataset.spanFrames)>overviewLimit();
  const editor=createPlayerWaveEditor({canvas,wrap,
    overviewSelection:$("wet-wave-overview-selection"),markerA:$("wet-wave-a-marker"),markerB:$("wet-wave-b-marker"),
    zoomIn:$("wet-wave-zoom-in"),zoomOut:$("wet-wave-zoom-out"),zoomLabel:$("wet-wave-zoom-label"),
    rulerTicks:[...wrap.querySelectorAll("[data-ruler-tick]")],
    getPosition:()=>signal?(request??getFrame())/signal.sampleRate:0,
    onPosition:seconds=>{
      if(closed||!signal)return;
      request=Math.max(0,Math.min(length()-1,Math.round(seconds*signal.sampleRate)));
      onSeek(request);
    },
    onStart:()=>{},onScrubMotion:()=>{},
    onScrubState:()=>{},
    onAB:()=>({a:-length()-1,b:2*length()+1,enabled:false})
  });
  const resize=new ResizeObserver(()=>{if(!closed)editor.refresh(true);});resize.observe(wrap);
  function setNote(){
    if(!signal)return;
    const frames=length(),wide=!!waveSource&&wideView();
    $("wet-wave-note").textContent="Wet出力の0始点。IR tailを含む全Wet時間軸（"+
      (frames/signal.sampleRate).toFixed(3)+" s）"+
      (wide?" / 全体波形 "+overviewReady+"/"+OVERVIEW_BINS:"");
  }
  function requestOverview(){
    if(closed||!signal||!waveSource||overviewTask)return;
    if(!wideView()||Date.now()<overviewRetryAfter)return;
    const identity=signalIdentity,reader=waveSource,revision=overviewRevision,frames=length();
    const peaks=reader.overviewPeaks;
    const center=Math.max(0,Math.min(frames-1,Math.round(getFrame())));
    const centerBin=Math.min(OVERVIEW_BINS-1,Math.floor(center*OVERVIEW_BINS/frames));
    const order=[];
    for(let distance=0;distance<OVERVIEW_BINS;distance++){
      const right=centerBin+distance,left=centerBin-distance;
      if(right<OVERVIEW_BINS)order.push(right);
      if(distance&&left>=0)order.push(left);
    }
    overviewTask=(async()=>{
      for(const index of order){
        if(closed||revision!==overviewRevision||identity!==signalIdentity||!wideView())return;
        if(peaks[index])continue;
        const start=Math.floor(index*frames/OVERVIEW_BINS);
        const end=Math.min(frames,Math.floor((index+1)*frames/OVERVIEW_BINS));
        if(end<=start)continue;
        const peak=await readWetOverviewPeak(reader,start,end,{isCurrent:()=>
          !closed&&revision===overviewRevision&&identity===signalIdentity&&wideView()});
        if(!peak)return;
        peaks[index]=peak;
        overviewReady++;
        canvas.dataset.overviewBinsReady=String(overviewReady);
        editor.refreshOverview(start,end,index);
        if(overviewReady%16===0)setNote();
      }
      setNote();
    })().catch(()=>{
      if(closed||revision!==overviewRevision||identity!==signalIdentity)return;
      overviewRetryAfter=Date.now()+750;setNote();
      if(overviewTimer!==null)clearTimeout(overviewTimer);
      overviewTimer=setTimeout(()=>{overviewTimer=null;requestOverview();},800);
    }).finally(()=>{if(revision===overviewRevision)overviewTask=null;});
  }
  const zoomObserver=new MutationObserver(requestOverview);
  zoomObserver.observe(canvas,{attributes:true,attributeFilter:["data-span-frames"]});
  function refresh(force=false){
    if(closed||!signal)return;
    const frame=Math.max(0,Math.min(length()-1,request??getFrame()));
    $("wet-wave-position").textContent=(frame/signal.sampleRate).toFixed(3)+" s";
    setNote();
    editor.refresh(force);
    requestOverview();
  }
  return {
    setSignal(value){
      if(closed)return;
      const frames=value?.sourceFrames??value?.channels?.[0]?.length??0;
      const next=value&&Number.isSafeInteger(frames)&&frames>0&&
        Number.isFinite(value.sampleRate)&&value.sampleRate>0?{...value,sourceFrames:frames}:null;
      if(next&&signal&&value===signalIdentity)return refresh();
      if(!next&&!signal){panel.hidden=true;return;}
      overviewRevision++;
      if(overviewTimer!==null){clearTimeout(overviewTimer);overviewTimer=null;}
      overviewTask=null;overviewRetryAfter=0;overviewReady=0;
      signal=next;signalIdentity=value??null;
      panel.hidden=!signal;
      request=null;
      const reader=signal?.source??signal?.reader;
      waveSource=reader&&typeof reader.read==="function"?{...reader,overviewPeaks:Array(OVERVIEW_BINS).fill(null)}:null;
      canvas.dataset.overviewBinsReady="0";
      editor.setSource(waveSource??signal?.channels??null,
        signal?.sampleRate??48000);
      if(signal)refresh(true);else $("wet-wave-position").textContent="未準備";
    },
    refresh,
    commit(){request=null;refresh(true);},
    dispose(){closed=true;overviewRevision++;if(overviewTimer!==null)clearTimeout(overviewTimer);zoomObserver.disconnect();resize.disconnect();editor.setSource(null,signal?.sampleRate??48000);signal=null;signalIdentity=null;waveSource=null;panel.hidden=true;}
  };
}
