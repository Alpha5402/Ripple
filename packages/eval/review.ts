import { KernelError } from '../core/model.js';
export interface HumanRelationReview {
  relationId: string; grade: 0 | 1 | 2 | 3; previouslyKnown: boolean; wouldHaveSearched: boolean;
  usefulAfterReading: boolean; reviewer: string; reviewedAt: string; note?: string;
}
export function validateReview(value: unknown, allowedRelationIds: Set<string>): asserts value is HumanRelationReview {
  const review = value as HumanRelationReview;
  if (!review || !allowedRelationIds.has(review.relationId) || ![0, 1, 2, 3].includes(review.grade)
    || ['previouslyKnown', 'wouldHaveSearched', 'usefulAfterReading'].some(key => typeof (review as unknown as Record<string, unknown>)[key] !== 'boolean')
    || typeof review.reviewer !== 'string' || !review.reviewer.trim() || typeof review.reviewedAt !== 'string' || !Number.isFinite(Date.parse(review.reviewedAt))) {
    throw new KernelError('INVALID_INPUT', 'Review must identify an existing pair, a 0–3 grade, explicit discovery judgments, reviewer and date');
  }
}
export function summarizeReviews(reviews: HumanRelationReview[]) {
  return { reviewed: reviews.length, useful: reviews.filter(r => r.grade >= 2 && r.usefulAfterReading).length,
    unexpectedUseful: reviews.filter(r => r.grade >= 2 && r.usefulAfterReading && !r.previouslyKnown && !r.wouldHaveSearched).map(r => r.relationId) };
}
