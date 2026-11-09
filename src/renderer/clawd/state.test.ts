import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CLIPS, frameRate, MAX_STEP_S, type Clip } from './state';

const clips = Object.keys(CLIPS) as Clip[];

describe('mascot frame rates', () => {
  it('keeps every view on one 24 fps grid, so views at different paces share the window frames', () => {
    for (const clip of clips) {
      for (const large of [true, false]) {
        for (const quiet of [true, false]) assert.equal(24 % frameRate(clip, large, quiet), 0, `${clip} ${large} ${quiet}`);
      }
    }
  });

  it('animates the open conversation at the rig rate and the sidebar cards at half of it', () => {
    assert.equal(frameRate('work_type', true, false), 24);
    assert.equal(frameRate('work_type', false, false), 12);
    assert.equal(frameRate('wait_coffee', true, false), 12);
    assert.equal(frameRate('idle_hop', true, false), 12);
  });

  it('slows every mascot down while the hub is in the background', () => {
    for (const clip of clips) {
      for (const large of [true, false]) assert.ok(frameRate(clip, large, true) < frameRate(clip, large, false), clip);
    }
  });

  it('never cuts a frame short: the slowest step is still played in full', () => {
    for (const clip of clips) {
      for (const large of [true, false]) {
        for (const quiet of [true, false]) assert.ok(1 / frameRate(clip, large, quiet) < MAX_STEP_S, `${clip} ${large} ${quiet}`);
      }
    }
  });
});
