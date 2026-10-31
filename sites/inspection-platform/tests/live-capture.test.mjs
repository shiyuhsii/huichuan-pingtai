import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canAutoShowCapture, latestFpgaCapture, visibleBoxes} from '../app/lib/live-capture.ts';

test('new CNN capture can open automatically only while review is idle', () => {
  const idle = {enabled:true, dirty:false, busy:false, importing:false, drawing:false, dragging:false};
  assert.equal(canAutoShowCapture(idle), true);
  assert.equal(canAutoShowCapture({...idle, enabled:false}), false);
  for (const key of ['dirty','busy','importing','drawing','dragging']) {
    assert.equal(canAutoShowCapture({...idle, [key]:true}), false, key);
  }
});

test('FPGA selection ignores newer manually imported photos', () => {
  const frame = {id:'frame',source:'fpga',boxes:[]};
  assert.equal(latestFpgaCapture([{id:'photo',source:'manual'},frame]), frame);
  assert.equal(latestFpgaCapture([]), undefined);
});

test('removed frame stays recoverable but is excluded from active review', () => {
  const kept = {id:'1',label:'scratch'};
  const removed = {id:'2',label:'pending',removed:true};
  const record = {boxes:[kept,removed]};
  assert.deepEqual(visibleBoxes(record), [kept]);
  assert.equal(record.boxes[1], removed);
  assert.deepEqual(visibleBoxes({boxes:[kept,{...removed,removed:false}]}).map(box=>box.id), ['1','2']);
});
