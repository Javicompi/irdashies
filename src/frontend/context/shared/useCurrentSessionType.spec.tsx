import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCurrentSessionType } from './useCurrentSessionType';
import { useSessionType } from '@irdashies/context';
import { useTelemetryValue } from '../TelemetryStore/TelemetryStore';

// Mock the context hooks
vi.mock('@irdashies/context', async (importOriginal) => {
  const original = await importOriginal<typeof import('@irdashies/context')>();
  return {
    ...original,
    useSessionType: vi.fn(),
  };
});

vi.mock('../TelemetryStore/TelemetryStore', () => ({
  useTelemetryValue: vi.fn(),
}));

describe('useCurrentSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return the session type when session number is available', () => {
    vi.mocked(useTelemetryValue).mockReturnValue(1);
    // Mock the session type
    vi.mocked(useSessionType).mockReturnValue('Race');

    const { result } = renderHook(() => useCurrentSessionType());

    expect(result.current).toBe('Race');
    expect(useTelemetryValue).toHaveBeenCalledWith('SessionNum');
    expect(useSessionType).toHaveBeenCalledWith(1);
  });

  it('should return undefined when session number is not available', () => {
    vi.mocked(useTelemetryValue).mockReturnValue(undefined);
    // Mock the session type
    vi.mocked(useSessionType).mockReturnValue(undefined);

    const { result } = renderHook(() => useCurrentSessionType());

    expect(result.current).toBeUndefined();
    expect(useTelemetryValue).toHaveBeenCalledWith('SessionNum');
    expect(useSessionType).toHaveBeenCalledWith(undefined);
  });
});
