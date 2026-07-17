/**
 * Problem+JSON (RFC 7807) error shape used by the REST + WS API.
 * See SPEC.md § 2.5 for the canonical code → meaning mapping.
 */
export type ProblemCode =
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RISK_BLOCKED'
  | 'BROKER_DOWN'
  | 'RECONCILING'
  | 'INTERNAL';

export type Problem = {
  type?: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
  instance?: string;
  /** free-form extension fields for the caller */
  [k: string]: unknown;
};

export const problem = (p: Problem) => p;

export const CODE_TO_STATUS: Record<ProblemCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RISK_BLOCKED: 409,
  BROKER_DOWN: 502,
  RECONCILING: 503,
  INTERNAL: 500,
};

export class ProblemError extends Error {
  readonly problem: Problem;
  constructor(p: Problem) {
    super(p.title);
    this.problem = p;
  }
}
