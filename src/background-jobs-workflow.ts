/**
 * Optional OpenClaw session workflow hooks for background-job completion delivery.
 */
export type ScheduleSessionTurnParams = {
  sessionKey: string;
  message: string;
  agentId?: string;
  delayMs?: number;
  deliveryMode?: "none" | "announce";
  tag?: string;
  deleteAfterRun?: boolean;
};

export type BackgroundJobWorkflowHooks = {
  scheduleSessionTurn?: (
    params: ScheduleSessionTurnParams,
  ) => Promise<unknown>;
};

let workflowHooks: BackgroundJobWorkflowHooks | undefined;

export function configureBackgroundJobWorkflow(hooks: BackgroundJobWorkflowHooks): void {
  workflowHooks = hooks;
}

export function getBackgroundJobWorkflowHooks(): BackgroundJobWorkflowHooks | undefined {
  return workflowHooks;
}

export function resetBackgroundJobWorkflowForTests(): void {
  workflowHooks = undefined;
}
