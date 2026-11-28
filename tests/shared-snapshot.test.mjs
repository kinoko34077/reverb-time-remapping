import test from "node:test";
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {createHash} from "node:crypto";

for(const [dir,owner] of [["atf","audio-time-frequency-lab"],["fw","frequency-warp-vst"]]){
  test("pinned "+owner+" supply is exact and has no untracked modules",async()=>{
    const root=new URL("../shared/"+dir+"/",import.meta.url);
    const manifest=JSON.parse(await readFile(new URL("manifest.json",root),"utf8"));
    assert.equal(manifest.repository,"kinoko34077/"+owner);
    assert.match(manifest.commit,/^[a-f0-9]{40}$/);
    const files=async(dir,prefix="")=>(await Promise.all((await readdir(dir,{withFileTypes:true})).map(async entry=>{
      const name=prefix+entry.name;
      return entry.isDirectory()?files(new URL(entry.name+"/",dir),name+"/"):[name];
    }))).flat();
    assert.deepEqual((await files(root)).sort(),["manifest.json",...Object.keys(manifest.files)].sort());
    for(const [file,meta] of Object.entries(manifest.files)){
      assert.match(file,/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/);
      assert.equal(meta.source,"web-demo/"+file);
      assert.match(meta.gitBlob,/^[a-f0-9]{40}$/);
      const bytes=await readFile(new URL(file,root));
      const blob=createHash("sha1").update("blob "+bytes.length+"\0").update(bytes).digest("hex");
      assert.equal(blob,meta.gitBlob,"owner file must not be edited locally: "+file);
    }
  });
}
