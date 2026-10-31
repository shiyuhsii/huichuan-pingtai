import type {InspectionRecord} from './types';

export function latestFpgaCapture(records: InspectionRecord[]) {
  return records.find(record => record.source === 'fpga');
}

// Receiving a frame must never discard an unfinished review or interrupt a draw.
export function canAutoShowCapture(state: {
  enabled: boolean; dirty: boolean; busy: boolean; importing: boolean;
  drawing: boolean; dragging: boolean;
}) {
  return state.enabled && !state.dirty && !state.busy && !state.importing
    && !state.drawing && !state.dragging;
}

export function visibleBoxes(record: InspectionRecord) {
  return record.boxes.filter(box => !box.removed);
}
