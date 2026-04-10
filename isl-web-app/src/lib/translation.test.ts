import {buildPoseUrl} from './translation';
import {describe, expect, it} from 'vitest';

describe('buildPoseUrl', () => {
  it('creates the hosted pose url with encoded query parameters', () => {
    expect(buildPoseUrl('Hello world', 'en', 'ase')).toBe(
      'https://us-central1-sign-mt.cloudfunctions.net/spoken_text_to_signed_pose?text=Hello+world&spoken=en&signed=ase'
    );
  });
});

