import {describe, expect, it} from 'vitest';
import {mergeSubtitleCues, normalizeSubtitleCues, parseSubtitleCues} from './subtitleParser';

describe('parseSubtitleCues', () => {
  it('parses standard SRT blocks', () => {
    expect(
      parseSubtitleCues(`1
00:00:00,000 --> 00:00:01,500
Hello there

2
00:00:02,000 --> 00:00:03,200
General Kenobi
`)
    ).toEqual([
      {
        start: 0,
        end: 1.5,
        text: 'Hello there',
      },
      {
        start: 2,
        end: 3.2,
        text: 'General Kenobi',
      },
    ]);
  });

  it('parses VTT blocks and strips tags', () => {
    expect(
      parseSubtitleCues(`WEBVTT

00:00.000 --> 00:01.250 align:start
<c.colorE5E5E5>Hello</c>

00:01.500 --> 00:03.000
world
`)
    ).toEqual([
      {
        start: 0,
        end: 1.25,
        text: 'Hello',
      },
      {
        start: 1.5,
        end: 3,
        text: 'world',
      },
    ]);
  });

  it('clips overlapping rolling-window cues to the next cue start', () => {
    expect(
      parseSubtitleCues(`1
00:00:00,240 --> 00:00:09,599
Hello everyone, welcome to my first slow

2
00:00:05,839 --> 00:00:14,080
English podcast. In this podcast, you

3
00:00:09,599 --> 00:00:18,080
will listen and then you will repeat
`)
    ).toEqual([
      {
        start: 0.24,
        end: 5.839,
        text: 'Hello everyone, welcome to my first slow',
      },
      {
        start: 5.839,
        end: 9.599,
        text: 'English podcast. In this podcast, you',
      },
      {
        start: 9.599,
        end: 18.08,
        text: 'will listen and then you will repeat',
      },
    ]);
  });
});

describe('mergeSubtitleCues', () => {
  it('merges nearby subtitle cues into semantic chunks', () => {
    expect(
      mergeSubtitleCues([
        {start: 0, end: 0.8, text: 'This is'},
        {start: 0.82, end: 1.5, text: 'a short sentence.'},
        {start: 3, end: 4, text: 'New thought starts here'},
      ])
    ).toEqual([
      {
        start: 0,
        end: 1.5,
        text: 'This is a short sentence.',
      },
      {
        start: 3,
        end: 4,
        text: 'New thought starts here',
      },
    ]);
  });

  it('drops cues that have no exclusive time before the next overlap begins', () => {
    expect(
      normalizeSubtitleCues([
        {start: 0, end: 3, text: 'First'},
        {start: 0, end: 4, text: 'Second'},
        {start: 4, end: 5, text: 'Third'},
      ])
    ).toEqual([
      {start: 0, end: 4, text: 'Second'},
      {start: 4, end: 5, text: 'Third'},
    ]);
  });
});
