import {renderIRSpectral} from "./ir-spectral.mjs";
let ir=null;
self.onmessage=({data})=>{
  const {id,source,settings}=data;
  try{
    if(source)ir=source;
    if(!ir)throw Error("IR未準備");
    const kernel=renderIRSpectral(ir,settings);
    self.postMessage({id,kernel},kernel.channels.map(c=>c.buffer));
  }catch(error){self.postMessage({id,error:error.message});}
};
