import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CLIPS, frameRate, MAX_STEP_S, type Clip } from './state';

const clips = Object.keys(CLIPS) as Clip[];

describe('mascot frame rates', () => {
  it('keeps every view on one 24 fps grid, so views at different paces share the window frames', () => {
    for (const clip of clips) {
      for (const large of [true, false]) {
        for (const onBattery of [true, false]) assert.equal(24 % frameRate(clip, large, onBattery), 0, `${clip} ${large} ${onBattery}`);
      }
    }
  });

  it('animates the open conversation at the rig rate and the sidebar cards at half of it', () => {
    assert.equal(frameRate('work_type', true, false), 24);
    assert.equal(frameRate('work_type', false, false), 12);
    assert.equal(frameRate('wait_coffee', true, false), 12);
    assert.equal(frameRate('idle_hop', true, false), 12);
  });

  it('halves every pace on battery', () => {
    for (const clip of clips) {
      for (const large of [true, false]) assert.equal(frameRate(clip, large, true) * 2, frameRate(clip, large, false), clip);
    }
  });

  it('never cuts a frame short: the slowest step is still played in full', () => {
    for (const clip of clips) {
      for (const large of [true, false]) {
        for (const onBattery of [true, false]) assert.ok(1 / frameRate(clip, large, onBattery) < MAX_STEP_S, `${clip} ${large} ${onBattery}`);
      }
    }
  });
});
