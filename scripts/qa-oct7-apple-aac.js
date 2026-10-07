'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const analyzer=require('../backend/voice_validator');
const {measureAndValidateCaptures}=require('../lib/measured-capture-duration-gate');
const ffmpeg=require('ffmpeg-static');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'alzo-apple-aac-'));
function apple(seconds){
 const wav=path.join(root,seconds+'.wav'),aac=path.join(root,seconds+'.m4a');
 cp.execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t',String(seconds),wav]);
 cp.execFileSync('/usr/bin/afconvert',['-f','m4af','-d','aac',wav,aac]);return aac;
}
(async()=>{
 const files=Object.fromEntries([6.999,7,11,20].map(s=>[s,apple(s)]));
 assert(!fs.readFileSync(files[11]).includes(Buffer.from('elst')),'fixture must exercise Apple no-edit format');
 assert.equal((await analyzer.analyzeFile(files[11])).duration,11);
 assert.equal((await analyzer.analyzeFile(files[7])).duration,7);
 assert.equal((await measureAndValidateCaptures([files[6.999],files[11],files[11],files[20]],analyzer.analyzeFile)).ok,false);
 assert.equal((await measureAndValidateCaptures([files[7],files[11],files[11],files[20]],analyzer.analyzeFile)).ok,true);
 assert.equal((await measureAndValidateCaptures([files[7],files[7],files[7],files[7]],analyzer.analyzeFile)).ok,false);
 const truncated=path.join(root,'truncated.m4a'),bytes=fs.readFileSync(files[11]);fs.writeFileSync(truncated,bytes.subarray(0,Math.round(bytes.length/3)));
 assert.equal((await analyzer.analyzeFile(truncated)).ok,false);
 const tampered=Buffer.from(bytes),pos=tampered.indexOf(Buffer.from('iTunSMPB'));assert(pos>0);
 tampered[pos]='X'.charCodeAt(0);const unknown=path.join(root,'unknown-priming.m4a');fs.writeFileSync(unknown,tampered);
 assert.equal((await analyzer.analyzeFile(unknown)).ok,false,'no guessed AAC priming');
 const missing=await measureAndValidateCaptures([path.join(root,'missing.m4a'),files[11],files[11],files[20]],analyzer.analyzeFile);
 assert.equal(missing.failures[0].analysisReason,'file_missing');
 console.log(JSON.stringify({pass:true,fixtureDir:root,decoder:ffmpeg,apple11Seconds:11,shortRejected:true,exact7Accepted:true,total28Rejected:true,truncatedRejected:true,unknownPrimingRejected:true}));
})().catch(e=>{console.error(e.stack);process.exitCode=1});
