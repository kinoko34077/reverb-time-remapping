import {createPlayerWaveEditor} from "../shared/atf/player-wave-editor.mjs";

// The waveform reads the same bounded Wet source used by playback. Wet frame
// zero is its own output origin and may extend past the Source's final frame.
export function createWetWaveView({getFrame,onSeek}){
  const $=id=>document.getElementById(id);
  const canvas=$("wet-wave-detail"),wrap=$("wet-wave-detail-wrap"),panel=$("wet-wave-panel");
  let signal=null,signalIdentity=null,request=null,closed=false;
  const length=()=>signal?.sourceFrames??signal?.channels?.[0]?.length??0;
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
  function refresh(force=false){
    if(closed||!signal)return;
    const frame=Math.max(0,Math.min(length()-1,request??getFrame()));
    $("wet-wave-position").textContent=(frame/signal.sampleRate).toFixed(3)+" s";
    $("wet-wave-note").textContent="Wet出力の0始点。IR tailを含む全Wet時間軸（"+
      (length()/signal.sampleRate).toFixed(3)+" s）";
    editor.refresh(force);
  }
  return {
    setSignal(value){
      if(closed)return;
      const frames=value?.sourceFrames??value?.channels?.[0]?.length??0;
      const next=value&&Number.isSafeInteger(frames)&&frames>0&&
        Number.isFinite(value.sampleRate)&&value.sampleRate>0?{...value,sourceFrames:frames}:null;
      if(next&&signal&&value===signalIdentity)return refresh();
      if(!next&&!signal){panel.hidden=true;return;}
      signal=next;signalIdentity=value??null;
      panel.hidden=!signal;
      request=null;
      const reader=signal?.source??signal?.reader;
      editor.setSource(reader&&typeof reader.read==="function"?reader:signal?.channels??null,
        signal?.sampleRate??48000);
      if(signal)refresh(true);else $("wet-wave-position").textContent="未準備";
    },
    refresh,
    commit(){request=null;refresh(true);},
    dispose(){closed=true;resize.disconnect();editor.setSource(null,signal?.sampleRate??48000);signal=null;signalIdentity=null;panel.hidden=true;}
  };
}
