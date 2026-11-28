import {createPlayerWaveEditor} from "../shared/atf/player-wave-editor.mjs";
// One persistent editor instance. It displays material-local frames, while
// the player owns the signed comparison coordinates. No duplicated gestures.
export function createSourceWaveView({getFrame,getRange,onSeek,onRange}){
  const $=id=>document.getElementById(id);
  const canvas=$("wave-detail"),wrap=$("wave-detail-wrap");
  let source=null,interval=null,request=null,gesture=false,closed=false;
  const length=()=>source?.sourceFrames??source?.channels[0].length??0;
  const offset=()=>source&&interval?(source.origin??0)-interval.start:0;
  const local=frame=>Math.max(0,Math.min(length()-1,frame-offset()));
  const editor=createPlayerWaveEditor({canvas,wrap,overviewSelection:$("wave-overview-selection"),
    markerA:$("wave-a-marker"),markerB:$("wave-b-marker"),zoomIn:$("wave-zoom-in"),zoomOut:$("wave-zoom-out"),
    zoomLabel:$("wave-zoom-label"),rulerTicks:[...wrap.querySelectorAll("[data-ruler-tick]")],
    getPosition:()=>source?(request??local(getFrame()))/source.sampleRate:0,
    onPosition:(seconds)=>{if(closed||!source)return;request=local(seconds*source.sampleRate+offset());onSeek(Math.round(request)+offset());},
    onStart:()=>{},onScrubMotion:()=>{},onScrubState:active=>{gesture=active;if(!active)request=null;},
    onAB:(edge,frame)=>{
      const range=getRange(),n=length();
      if(edge&&range&&source){onRange(edge,Math.round(frame)+offset());}
      // In linked playback there is no Source-specific loop; put its
      // disabled handles outside the detail viewport rather than advertise
      // an editable range. The editor's selection element is hidden here.
      return range?{a:range.rangeStartFrame-offset(),b:range.rangeEndFrame-offset(),enabled:range.repeat}:
        {a:-n-1,b:2*n+1,enabled:false};
    }
  });
  const resize=new ResizeObserver(()=>{if(!closed)editor.refresh(true);});resize.observe(wrap);
  function refresh(force=false){
    if(closed||!source)return;
    if(!gesture)request=null;
    const actual=getFrame()-offset(),n=length(),range=getRange();
    $("source-wave-panel").dataset.loopAvailable=String(!!range);
    $("source-wave-position").textContent=actual<0?"原音開始前":actual>=n?"原音終了後":
      (actual/source.sampleRate).toFixed(3)+" s";
    $("source-wave-note").textContent="素材内時刻（0始点） / 比較時刻 "+((getFrame()+interval.start)/source.sampleRate).toFixed(3)+" s";
    editor.refresh(force);
  }
  return {setSource(value,session){source=value;interval=session.interval;request=null;
    editor.setSource(typeof value.read==="function"?value:value.channels,value.sampleRate);refresh(true);},
    setInterval(session){interval=session.interval;refresh(true);},refresh,
    dispose(){closed=true;resize.disconnect();editor.setSource(null,source?.sampleRate??48000);source=null;}};
}
