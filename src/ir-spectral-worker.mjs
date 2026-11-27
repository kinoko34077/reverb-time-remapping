// One worker and one active job; the application owns latest-request policy.
// The immutable IR is cloned only on generation changes. Kernel PCM is transferred.
export function createIRSpectralWorker({WorkerCtor=globalThis.Worker}={}){
  let worker=null,source=null,pending=null,id=0,disposed=false;
  function reset(error=Error("IR再合成を取り消しました")){
    const active=pending;pending=null;source=null;
    if(worker){worker.terminate();worker=null;}
    if(active){clearTimeout(active.timer);active.reject(error);}
  }
  function ensure(){
    if(disposed)throw Error("IR再合成Workerは終了済みです");
    if(worker)return;
    if(typeof WorkerCtor!=="function")throw Error("IR再合成Workerを利用できません");
    const next=new WorkerCtor(new URL("./ir-spectral.worker.mjs",import.meta.url),{type:"module"});
    worker=next;
    next.onmessage=({data})=>{
      if(worker!==next||!pending||pending.id!==data?.id)return;
      const job=pending;pending=null;clearTimeout(job.timer);
      if(data.error)job.reject(Error(data.error));else job.resolve(data.kernel);
    };
    const fail=event=>{if(worker===next)reset(Error(event.message||"IR再合成Workerに失敗しました"));};
    next.onerror=fail;next.onmessageerror=fail;
  }
  function render(ir,settings){
    if(pending)return Promise.reject(Error("IR再合成は既に計算中です"));
    try{ensure();}catch(error){return Promise.reject(error);}
    return new Promise((resolve,reject)=>{
      const request=++id;
      const timer=setTimeout(()=>reset(Error("IR再合成Workerの応答がありません")),60000);
      pending={id:request,resolve,reject,timer};
      try{
        worker.postMessage({id:request,settings,...(source===ir?{}:{source:ir})});
        source=ir;
      }catch(error){reset(error);}
    });
  }
  return {render,cancel:()=>reset(),dispose(){disposed=true;reset();}};
}
