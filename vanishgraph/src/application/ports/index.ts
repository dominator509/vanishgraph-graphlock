/**
 * Application-layer ports.
 *
 * Only `JobQueue` lives here: it is the single port the domain does not own, because
 * *when* to run something later is orchestration rather than a domain concept
 * (SPEC-001 §5.1).
 */
export type { JobDefinition, JobQueue, TransactionHandle } from './job-queue.ts';
