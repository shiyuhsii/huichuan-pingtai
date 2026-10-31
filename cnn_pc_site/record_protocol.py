"""VFAUTO1 protocol, no GUI or third-party image dependencies."""
from dataclasses import dataclass
from pathlib import Path
from datetime import datetime
import json
import os
import struct
import uuid
import zlib

MAGIC=b'VFAUTO1!'
META=struct.Struct('<BBBBIHHHHHBBHH')
MAX_PAYLOAD=1920

def command(opcode, session=0):
    body=struct.pack('<BI',opcode,session)
    check=0
    for n in body: check^=n
    return b'\xa5\x5a'+body+bytes([check])

@dataclass(frozen=True)
class Packet:
    kind:int
    session:int
    width:int
    height:int
    row:int
    threshold:int
    count:int
    seconds_bcd:int
    firmware:int
    payload:bytes

class Parser:
    def __init__(self):
        self.buffer=bytearray()
        self.bad_packets=0

    def feed(self,data):
        self.buffer.extend(data)
        result=[]
        while True:
            at=self.buffer.find(MAGIC)
            if at<0:
                self.buffer[:]=self.buffer[-7:]
                break
            if at: del self.buffer[:at]
            if len(self.buffer)<32: break
            v,k,hs,fmt,sid,w,h,row,thr,n,count,res,sec,fw=META.unpack(self.buffer[8:32])
            if (v,hs,fmt,res)!=(1,32,1,0) or k not in (1,2,3,4) or not (1<=w<=960 and 1<=h<=540) or n>MAX_PAYLOAD or n!=(w*2 if k==2 else 0):
                self.bad_packets+=1;del self.buffer[0];continue
            total=36+n
            if len(self.buffer)<total: break
            checksum=struct.unpack_from('<I',self.buffer,32+n)[0]
            if zlib.crc32(self.buffer[8:32+n])!=checksum:
                self.bad_packets+=1;del self.buffer[0];continue
            result.append(Packet(k,sid,w,h,row,thr,count,sec,fw,bytes(self.buffer[32:32+n])))
            del self.buffer[:total]
        return result

def elapsed_seconds(bcd):
    digits=[(bcd>>s)&15 for s in (8,4,0)]
    if bcd>0x999 or any(d>9 for d in digits): raise ValueError('Invalid BCD elapsed time')
    return digits[0]*100+digits[1]*10+digits[2]

def rgb_bytes(pixels):
    out=bytearray(len(pixels)//2*3)
    for i in range(0,len(pixels),2):
        gray,tag=pixels[i:i+2]
        if tag==0: color=(gray,gray,gray)
        elif tag==1: color=(255,32,32)
        elif tag==2: color=(0,255,255)
        else: raise ValueError('Invalid screenshot color tag')
        out[i//2*3:i//2*3+3]=bytes(color)
    return bytes(out)

def bmp_bytes(width,height,pixels):
    rgb=rgb_bytes(pixels)
    stride=(width*3+3)&~3
    image=bytearray(stride*height)
    for y in range(height):
        for x in range(width):
            source=(y*width+x)*3;target=(height-1-y)*stride+x*3
            image[target:target+3]=rgb[source:source+3][::-1]
    return struct.pack('<2sIHHI',b'BM',54+len(image),0,0,54)+struct.pack('<IiiHHIIiiII',40,width,height,1,24,0,len(image),2835,2835,0,0)+image

class Assembler:
    def __init__(self): self.reset()
    def reset(self):
        self.start=None;self.next_row=0;self.pixels=bytearray()
    def accept(self,p):
        if p.kind==1:
            self.reset()
            if p.row!=0 or not 1<=p.count<=32: raise ValueError('Invalid positive detection BEGIN')
            elapsed_seconds(p.seconds_bcd)
            self.start=p
            return None
        if p.kind==4:
            if self.start and p.session==self.start.session: self.reset()
            return None
        if self.start is None: raise ValueError('Packet without BEGIN')
        a=self.start
        if (p.session,p.width,p.height,p.threshold,p.count,p.seconds_bcd,p.firmware)!=(a.session,a.width,a.height,a.threshold,a.count,a.seconds_bcd,a.firmware):
            self.reset();raise ValueError('Frame metadata changed during transfer')
        if p.kind==2:
            if p.row!=self.next_row or p.row>=p.height or len(p.payload)!=2*p.width or any(v>2 for v in p.payload[1::2]):
                self.reset();raise ValueError('Missing/duplicate row or invalid pixel')
            self.pixels.extend(p.payload);self.next_row+=1
            return None
        if p.kind==3:
            if self.next_row!=p.height or p.row!=p.height-1 or len(self.pixels)!=p.width*p.height*2:
                self.reset();raise ValueError('Incomplete detection image')
            completed=(a,bytes(self.pixels));self.reset();return completed
        raise ValueError('Unsupported packet')

def verify_folder(folder):
    folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    probe=folder/('.write-check-'+uuid.uuid4().hex)
    try:
        with probe.open('xb') as f:
            f.write(b'ready');f.flush();os.fsync(f.fileno())
    finally:
        if probe.exists(): probe.unlink()

def save_record(folder,packet,pixels):
    """Publish a directory only after BOTH files have been flushed successfully."""
    stamp=datetime.now().astimezone()
    parent=Path(folder)/stamp.strftime('%Y-%m-%d');parent.mkdir(parents=True,exist_ok=True)
    name=stamp.strftime('%H%M%S_%f')+f'_CNN_{packet.session:08X}_'+uuid.uuid4().hex[:8]
    staging=parent/('.pending_'+name);target=parent/name
    staging.mkdir()
    metadata={
        'record_id':name,'received_at':stamp.isoformat(),'fpga_session_id':packet.session,
        'firmware':'B3260012','capture':'frozen_CNN_detection_display','image':'detection.bmp',
        'width':packet.width,'height':packet.height,'threshold':packet.threshold,
        'fpga_scratch_count':packet.count,'elapsed_seconds':elapsed_seconds(packet.seconds_bcd),
        'elapsed_precision':'whole seconds, same as HDMI SEC',
        'transfer':'all rows present; each packet IEEE CRC32 verified',
        'part_id':'','batch':'','notes':'',
        'image_note':'Half-size paired HDMI screenshot before PC status overlay; not raw sensor data.'}
    try:
        for filename,data in [('detection.bmp',bmp_bytes(packet.width,packet.height,pixels)),('record.json',json.dumps(metadata,ensure_ascii=False,indent=2).encode('utf8'))]:
            with (staging/filename).open('xb') as f:
                f.write(data);f.flush();os.fsync(f.fileno())
        staging.rename(target)
    except BaseException:
        # Only remove files created by this call, never existing user records.
        for filename in ('detection.bmp','record.json'):
            p=staging/filename
            if p.exists(): p.unlink()
        if staging.exists(): staging.rmdir()
        raise
    return target
