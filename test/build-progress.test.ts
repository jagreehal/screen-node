import { describe, expect, it, vi } from 'vitest';
import { classifyImageState } from '../src/image.js';
import { buildNotice, createBuildReporter, type BuildReporterDriver } from '../src/build-progress.js';

describe('classifyImageState', () => {
  it('is absent when the image cannot be inspected', () => {
    expect(classifyImageState({ code: 1, label: '' }, 'abc123')).toBe('absent');
  });

  it('is current when the stamped fingerprint matches', () => {
    expect(classifyImageState({ code: 0, label: 'abc123\n' }, 'abc123')).toBe('current');
  });

  it('is stale when present but the fingerprint differs', () => {
    expect(classifyImageState({ code: 0, label: 'OLDHASH' }, 'abc123')).toBe('stale');
  });
});

describe('buildNotice', () => {
  it('frames an absent image as a one-time setup with context about what the image is', () => {
    const notice = buildNotice('absent');
    expect(notice.toLowerCase()).toContain('one-time');
    expect(notice).toContain('Node.js container');
    expect(notice).toContain('cached after');
  });

  it('frames a stale image as a rebuild because config changed, with context about reproducibility', () => {
    const notice = buildNotice('stale').toLowerCase();
    expect(notice).toContain('rebuild');
    expect(notice).toContain('config');
    expect(notice).toContain('reproducible');
  });
});

function recordingDriver(): { driver: BuildReporterDriver; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    driver: {
      start: (m) => calls.push(['start', m]),
      succeed: (m) => calls.push(['succeed', m]),
      fail: (m) => calls.push(['fail', m]),
    },
  };
}

describe('createBuildReporter', () => {
  it('announces the build with the state-specific notice on start', () => {
    const { driver, calls } = recordingDriver();
    createBuildReporter(driver).start('absent');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('start');
    expect(calls[0]?.[1].toLowerCase()).toContain('one-time');
  });

  it('reports success and failure through the driver', () => {
    const { driver, calls } = recordingDriver();
    const reporter = createBuildReporter(driver);
    reporter.start('stale');
    reporter.succeed();
    reporter.fail();
    expect(calls.map((c) => c[0])).toEqual(['start', 'succeed', 'fail']);
    expect(calls[1]?.[1].toLowerCase()).toContain('ready');
  });

  it('defaults to a stderr driver when none is supplied', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      createBuildReporter().start('absent');
      expect(write).toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
