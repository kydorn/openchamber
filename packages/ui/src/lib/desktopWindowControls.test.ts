import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_DESKTOP_WINDOW_CONTROLS_POSITION,
  getDesktopWindowControlsOrder,
  normalizeDesktopWindowControlsPosition,
  resolveDesktopWindowControlsSide,
} from './desktop';
import { useUIStore } from '@/stores/useUIStore';

describe('desktop window controls position', () => {
  test('defaults to right', () => {
    expect(DEFAULT_DESKTOP_WINDOW_CONTROLS_POSITION).toBe('right');
    expect(resolveDesktopWindowControlsSide(undefined)).toBe('right');
    expect(resolveDesktopWindowControlsSide('right')).toBe('right');
    expect(resolveDesktopWindowControlsSide('left')).toBe('left');
  });

  test('maps legacy auto to right', () => {
    expect(normalizeDesktopWindowControlsPosition('auto')).toBe('right');
    expect(normalizeDesktopWindowControlsPosition('left')).toBe('left');
    expect(normalizeDesktopWindowControlsPosition('right')).toBe('right');
    expect(normalizeDesktopWindowControlsPosition('invalid')).toEqual(undefined);
  });

  test('left uses macOS traffic-light order', () => {
    expect(getDesktopWindowControlsOrder('left')).toEqual(['close', 'minimize', 'maximize']);
  });

  test('right uses Windows order', () => {
    expect(getDesktopWindowControlsOrder('right')).toEqual(['minimize', 'maximize', 'close']);
  });
});

describe('useUIStore v12→v13 migration', () => {
  test('introduces classic style while preserving position', () => {
    const migrate = useUIStore.persist.getOptions().migrate!;
    const result = migrate({ desktopWindowControlsPosition: 'left' }, 12) as Record<string, unknown>;
    expect(result.desktopWindowControlsPosition).toBe('left');
    expect(result.desktopWindowControlsStyle).toBe('classic');
  });

  test('does not overwrite a persisted style', () => {
    const migrate = useUIStore.persist.getOptions().migrate!;
    const result = migrate({ desktopWindowControlsStyle: 'traffic-lights' }, 12) as Record<string, unknown>;
    expect(result.desktopWindowControlsStyle).toBe('traffic-lights');
  });

  test('coerces an invalid persisted style to classic', () => {
    const migrate = useUIStore.persist.getOptions().migrate!;
    const result = migrate({ desktopWindowControlsStyle: 'macos' }, 12) as Record<string, unknown>;
    expect(result.desktopWindowControlsStyle).toBe('classic');
  });
});
