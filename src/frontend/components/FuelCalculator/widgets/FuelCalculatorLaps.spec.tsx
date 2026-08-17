import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FuelCalculatorLaps } from './FuelCalculatorLaps';

vi.mock('@irdashies/context', () => ({
  useTotalRaceValue: vi.fn(),
}));

import { useTotalRaceValue } from '@irdashies/context';

const mockUseTotalRaceValue = vi.mocked(useTotalRaceValue);

const baseProps = {
  fuelData: { currentLap: 10 } as never,
  fuelUnits: 'L' as const,
};

describe('FuelCalculatorLaps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTotalRaceValue.mockReturnValue({
      totalRaceLaps: 49.9,
      leaderRaceLaps: 61.4,
      isFixedLapRace: false,
      totalRaceTime: 0,
      adjustedRaceTime: 0,
    } as never);
  });

  it('renders the LAPS title and both values with 1 decimal', () => {
    render(<FuelCalculatorLaps {...baseProps} />);
    expect(screen.getByText('LAPS')).toBeTruthy();
    expect(screen.getByText('You:')).toBeTruthy();
    expect(screen.getByText('Leader:')).toBeTruthy();
    expect(screen.getByText('49.9')).toBeTruthy();
    expect(screen.getByText('61.4')).toBeTruthy();
  });

  it('shows placeholders when no data is available', () => {
    mockUseTotalRaceValue.mockReturnValue({
      totalRaceLaps: 0,
      leaderRaceLaps: 0,
      isFixedLapRace: false,
      totalRaceTime: 0,
      adjustedRaceTime: 0,
    } as never);
    render(<FuelCalculatorLaps {...baseProps} />);
    const dashes = screen.getAllByText('--');
    expect(dashes.length).toBe(2);
  });

  it('colors orange when fraction is close to a whole lap (>= 0.85)', () => {
    mockUseTotalRaceValue.mockReturnValue({
      totalRaceLaps: 49.9, // fraction 0.9 -> orange
      leaderRaceLaps: 61.4,
      isFixedLapRace: false,
      totalRaceTime: 0,
      adjustedRaceTime: 0,
    } as never);
    render(<FuelCalculatorLaps {...baseProps} />);
    const youValue = screen.getByText('49.9');
    expect(youValue.className).toContain('text-orange-400');
    const leaderValue = screen.getByText('61.4');
    expect(leaderValue.className).toContain('text-white');
  });

  it('colors yellow when fraction is between 0.30 and 0.70', () => {
    mockUseTotalRaceValue.mockReturnValue({
      totalRaceLaps: 49.3, // fraction 0.3 -> yellow
      leaderRaceLaps: 61.7, // fraction 0.7 -> yellow
      isFixedLapRace: false,
      totalRaceTime: 0,
      adjustedRaceTime: 0,
    } as never);
    render(<FuelCalculatorLaps {...baseProps} />);
    expect(screen.getByText('49.3').className).toContain('text-yellow-400');
    expect(screen.getByText('61.7').className).toContain('text-yellow-400');
  });

  it('keeps white when fraction is stable (0.30 < frac < 0.70)', () => {
    mockUseTotalRaceValue.mockReturnValue({
      totalRaceLaps: 49.5,
      leaderRaceLaps: 61.5,
      isFixedLapRace: false,
      totalRaceTime: 0,
      adjustedRaceTime: 0,
    } as never);
    render(<FuelCalculatorLaps {...baseProps} />);
    expect(screen.getByText('49.5').className).toContain('text-white');
    expect(screen.getByText('61.5').className).toContain('text-white');
  });

  it('does not color before 3 laps completed', () => {
    mockUseTotalRaceValue.mockReturnValue({
      totalRaceLaps: 2.9, // fraction 0.9 would be orange, but < 3 laps
      leaderRaceLaps: 3.1,
      isFixedLapRace: false,
      totalRaceTime: 0,
      adjustedRaceTime: 0,
    } as never);
    render(
      <FuelCalculatorLaps
        {...baseProps}
        fuelData={{ currentLap: 2 } as never}
      />
    );
    expect(screen.getByText('2.9').className).toContain('text-white');
  });
});
