import { motion } from '../theme';
import { motionDuration, motionEasing } from './motion';

describe('motion', () => {
  it('mirrors the canonical theme.motion duration tokens', () => {
    expect(motionDuration).toBe(motion.duration);
    expect(motionDuration).toEqual({ immediate: 120, routine: 200, layout: 280 });
  });

  it('mirrors the canonical theme.motion easing tokens', () => {
    expect(motionEasing).toBe(motion.easing);
    expect(motionEasing.standard).toEqual([0.4, 0, 0.2, 1]);
    expect(motionEasing.decelerate).toEqual([0, 0, 0.2, 1]);
    expect(motionEasing.accelerate).toEqual([0.4, 0, 1, 1]);
  });
});
