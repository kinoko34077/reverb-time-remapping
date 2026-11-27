import test from "node:test";
import assert from "node:assert/strict";
import {createIRSpectralWorker} from "../src/ir-spectral-worker.mjs";
class FakeWorker{
  static instances=[];
  constructor(){this.messages=[];FakeWorker.instances.push(this);}
  postMessage(message){this.messages.push(message);}
  terminate(){this.terminated=true;}
  answer(message){this.onmessage({data:message});}
}
test("spectral worker retains one IR generation, rejects concurrent and stale results, recovers after cancellation",async()=>{
  const client=createIRSpectralWorker({WorkerCtor:FakeWorker}),ir={channels:[new Float32Array(4)],sampleRate:48000};
  try{
    const a=client.render(ir,{speed:0}),w=FakeWorker.instances.at(-1),first=w.messages[0];
    assert.equal(first.source,ir);
    await assert.rejects(client.render(ir,{}),/計算中/);
    w.answer({id:first.id-1,kernel:"stale"});w.answer({id:first.id,kernel:"a"});
    assert.equal(await a,"a");
    const b=client.render(ir,{speed:1}),second=w.messages[1];assert.ok(!("source" in second));
    w.answer({id:second.id,kernel:"b"});assert.equal(await b,"b");
    const c=client.render(ir,{});client.cancel();await assert.rejects(c,/取り消し/);assert.equal(w.terminated,true);
    const d=client.render(ir,{}),w2=FakeWorker.instances.at(-1);
    assert.notEqual(w2,w);assert.equal(w2.messages[0].source,ir);
    w.answer({id:w2.messages[0].id,kernel:"stale"});
    w2.answer({id:w2.messages[0].id,kernel:"d"});assert.equal(await d,"d");
    const e=client.render(ir,{});w2.onerror({message:"fault"});await assert.rejects(e,/fault/);
    const f=client.render(ir,{}),w3=FakeWorker.instances.at(-1);assert.notEqual(w3,w2);
    w3.answer({id:w3.messages[0].id,error:"invalid kernel"});await assert.rejects(f,/invalid kernel/);
  }finally{client.dispose();}
  await assert.rejects(client.render(ir,{}),/終了済み/);
});
