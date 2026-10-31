import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateBoxes,validateQuality,cleanText,imageDimensions} from '../app/lib/validation.ts';
const fixture=name=>new Uint8Array(readFileSync(new URL(`./fixtures/${name}`,import.meta.url)));
const view=bytes=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
test('normalized boxes preserve explicit review and reject out-of-frame / duplicates',()=>{
 const b={id:'1',x:.1,y:.2,w:.3,h:.4,label:'normal-hole',note:'孔洞',origin:'fpga'};
 assert.equal(validateBoxes([b])[0].label,'normal-hole');
 assert.throws(()=>validateBoxes([{...b,w:1}]));assert.throws(()=>validateBoxes([b,b]));assert.throws(()=>validateBoxes([{...b,x:NaN}]));assert.throws(()=>validateBoxes([{...b,label:'auto-pass'}]));
});

test('region removal keeps coordinates and labels for restore, with a strict optional boolean',()=>{
 const box={id:'remove-1',x:.1,y:.2,w:.3,h:.4,label:'scratch',note:'划痕复核',origin:'fpga'};
 assert.deepEqual(validateBoxes([box]),[box]);
 assert.deepEqual(validateBoxes([{...box,removed:true}]),[{...box,removed:true}]);
 assert.deepEqual(validateBoxes([{...box,removed:false}]),[{...box,removed:false}]);
 for(const removed of ['true',1,null,{},[]])assert.throws(()=>validateBoxes([{...box,removed}]));
});
test('quality accepts measured values and rejects invalid ratios',()=>{
 const q={brightness:128,darkRatio:.05,brightRatio:.1,sharpness:100,warnings:[],verdict:'good'};
 assert.deepEqual(validateQuality(q),q);assert.throws(()=>validateQuality({...q,brightRatio:2}));assert.throws(()=>cleanText('x'.repeat(121),'编号'));
 assert.throws(()=>validateQuality({...q,brightRatio:.6,darkRatio:.5}));assert.doesNotThrow(()=>validateQuality({...q,brightRatio:.7,darkRatio:.3}));
});
test('container dimensions reject unsupported disguised files and huge images',()=>{
 const png=fixture('tiny.png');
 assert.deepEqual(imageDimensions(png,'image/png'),{width:3,height:2});
 assert.throws(()=>imageDimensions(new TextEncoder().encode('<svg>hello</svg>'),'image/png'));
 assert.throws(()=>imageDimensions(png,'image/jpeg'));
 view(png).setUint32(16,12001);assert.throws(()=>imageDimensions(png,'image/png'));
 view(png).setUint32(16,6000);view(png).setUint32(20,6000);assert.throws(()=>imageDimensions(png,'image/png'));
});

// Each 3x2 fixture was encoded and successfully decoded using Pillow.
for(const [name,mime] of [['tiny.png','image/png'],['tiny.jpg','image/jpeg'],['tiny-progressive.jpg','image/jpeg'],['tiny.webp','image/webp'],['tiny-lossless.webp','image/webp'],['tiny-alpha.webp','image/webp'],['tiny-animated.webp','image/webp']]){
 test(`accepts complete real image container: ${name}`,()=>{
  assert.deepEqual(imageDimensions(fixture(name),mime),{width:3,height:2});
 });
}

test('rejects truncated PNG headers, missing IDAT/IEND and out-of-bounds chunks',()=>{
 const png=fixture('tiny.png');
 assert.throws(()=>imageDimensions(png.subarray(0,24),'image/png'));
 assert.throws(()=>imageDimensions(png.subarray(0,33),'image/png'));
 assert.throws(()=>imageDimensions(png.subarray(0,png.length-12),'image/png'));
 const withoutIdat=new Uint8Array(45);withoutIdat.set(png.subarray(0,33));withoutIdat.set(png.subarray(-12),33);
 assert.throws(()=>imageDimensions(withoutIdat,'image/png'));
 const overflowing=png.slice();view(overflowing).setUint32(33,0x7fffffff);
 assert.throws(()=>imageDimensions(overflowing,'image/png'));
});

test('rejects JPEG headers without scan data, missing EOI and broken segments',()=>{
 assert.throws(()=>imageDimensions(new Uint8Array([255,216,255,192,0,8,8,0,100,0,100,0]),'image/jpeg'));
 const jpg=fixture('tiny.jpg');
 assert.throws(()=>imageDimensions(jpg.subarray(0,jpg.length-2),'image/jpeg'));
 let sos=-1;for(let p=2;p<jpg.length-1;p++)if(jpg[p]===255&&jpg[p+1]===218){sos=p;break;}
 assert.ok(sos>0);const scanStart=sos+2+view(jpg).getUint16(sos+2);
 const noScanData=new Uint8Array(scanStart+2);noScanData.set(jpg.subarray(0,scanStart));noScanData.set([255,217],scanStart);
 assert.throws(()=>imageDimensions(noScanData,'image/jpeg'));
 const brokenSegment=jpg.slice();view(brokenSegment).setUint16(4,65535);
 assert.throws(()=>imageDimensions(brokenSegment,'image/jpeg'));
});

test('rejects WebP RIFF length errors, VP8X-only headers and empty bitstreams',()=>{
 const webp=fixture('tiny.webp');const wrongLength=webp.slice();view(wrongLength).setUint32(4,webp.length+20,true);
 assert.throws(()=>imageDimensions(wrongLength,'image/webp'));
 assert.throws(()=>imageDimensions(webp.subarray(0,webp.length-2),'image/webp'));
 const vp8HeaderOnly=webp.slice(0,30);view(vp8HeaderOnly).setUint32(4,22,true);view(vp8HeaderOnly).setUint32(16,10,true);
 assert.throws(()=>imageDimensions(vp8HeaderOnly,'image/webp'));
 const vp8xOnly=fixture('tiny-alpha.webp').slice(0,30);view(vp8xOnly).setUint32(4,22,true);
 assert.throws(()=>imageDimensions(vp8xOnly,'image/webp'));
 const malformedLossless=fixture('tiny-lossless.webp');malformedLossless[20]=0;
 assert.throws(()=>imageDimensions(malformedLossless,'image/webp'));
});

for(const orientation of [5,6,7,8]){
 test(`EXIF orientation ${orientation} uses displayed 2x3 dimensions`,()=>{
  assert.deepEqual(imageDimensions(fixture(`tiny-orientation-${orientation}.jpg`),'image/jpeg'),{width:2,height:3});
 });
}
test('EXIF mirroring alone does not swap image dimensions',()=>{
 assert.deepEqual(imageDimensions(fixture('tiny-orientation-2.jpg'),'image/jpeg'),{width:3,height:2});
});
test('non-EXIF APP1 metadata does not reset an earlier image orientation',()=>{
 const jpg=fixture('tiny-orientation-6.jpg');
 const metadata=new Uint8Array([255,225,0,6,88,77,80,0]);
 const withExtra=new Uint8Array(jpg.length+metadata.length);
 withExtra.set(jpg.subarray(0,jpg.length-2));withExtra.set(metadata,jpg.length-2);withExtra.set([255,217],withExtra.length-2);
 assert.deepEqual(imageDimensions(withExtra,'image/jpeg'),{width:2,height:3});
});
