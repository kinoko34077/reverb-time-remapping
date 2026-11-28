import {createPlayerWaveEditor} from "../shared/atf/player-wave-editor.mjs";

// The editor owns waveform gestures and painting. Numeric window fields remain
// canonical so direct manipulation and precise entry stay synchronized.
export function createIRWaveView({getWindow,onStart,onEdge,canEdit}){
  const $=id=>document.getElementById(id);
  const canvas=$("ir-wave-detail"),wrap=$("ir-wave-detail-wrap");
  let ir=null,closed=false,viewportFrame=null;
  const editor=createPlayerWaveEditor({canvas,wrap,overviewSelection:$("ir-wave-overview-selection"),
    markerA:$("ir-wave-a-marker"),markerB:$("ir-wave-b-marker"),
    zoomIn:$("ir-wave-zoom-in"),zoomOut:$("ir-wave-zoom-out"),zoomLabel:$("ir-wave-zoom-label"),
    rulerTicks:[...wrap.querySelectorAll("[data-ruler-tick]")],
    // The shared editor computes handle positions relative to its playhead
    // anchor. Keep that anchor fixed during an endpoint gesture so moving A
    // does not shift the coordinate system under the pointer.
    getPosition:()=>ir?(viewportFrame??getWindow().start)/ir.sampleRate:0,
    onPosition:seconds=>{if(!closed&&ir&&canEdit())onStart(seconds);},
    onStart:()=>{},onScrubMotion:()=>{},onScrubState:()=>{},
    onAB:(edge,frame)=>{
      if(!edge&&ir&&!wrap.dataset.interaction)viewportFrame=getWindow().start;
      if(edge&&ir&&canEdit())onEdge(edge,frame);
      const range=ir?getWindow():{start:0,end:0};
      return {a:range.start,b:range.end,enabled:!!ir};
    }
  });
  const resize=new ResizeObserver(()=>{if(!closed)editor.refresh(true);});
  resize.observe(wrap);
  return {
    setIR(value){
      if(closed)return;
      ir=value&&Array.isArray(value.channels)&&value.channels.length?value:null;
      viewportFrame=ir?getWindow().start:null;
      editor.setSource(ir?.channels??null,ir?.sampleRate??48000);
      editor.refresh(true);
    },
    refresh(force=false){if(!closed&&ir)editor.refresh(force);},
    dispose(){closed=true;resize.disconnect();editor.setSource(null,ir?.sampleRate??48000);ir=null;viewportFrame=null;}
  };
}
