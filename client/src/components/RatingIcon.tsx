import type { DayRating } from '@/lib/tradeTypes';

export interface RatingIconProps {
  rating: DayRating;
}

export function RatingIcon({ rating }: RatingIconProps) {
  switch (rating) {
    case 'jackpot':
      return <span className="text-[0.6875rem]" title="≥50%">👑</span>;
    case 'crown':
      return <span className="text-[0.6875rem]" title="≥20%">🏆</span>;
    case 'double_trophy':
      return <span className="text-[0.6875rem]" title="≥10%">💰</span>;
    case 'trophy':
      return <span className="text-[0.6875rem]" title="≥5% Single Day">👍</span>;
    case 'star':
      return <span className="text-[0.6875rem]" title="≥5% Multi-Day">⭐</span>;
    case 'gift':
      return <span className="text-[0.6875rem]" title="Auto-completed">🎁</span>;
    case 'finish':
      return <span className="text-[0.6875rem]" title="Day 250">🏁</span>;
    default:
      return null;
  }
}
