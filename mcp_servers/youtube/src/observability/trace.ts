import { AsyncLocalStorage } from "node:async_hooks";
import { CorrelationId, type Logger, type Stage } from "./logger.ts";
import { safeError, type ErrorCode } from "../errors.ts";
import type { ToolName } from "../server.ts";

type Outcome = "ok" | "error" | "timeout" | "cancelled";
type Span = {
  stage: Stage;
  stage_id: CorrelationId;
  parent_stage_id?: CorrelationId;
  refresh_id?: CorrelationId;
  started: number;
};
type Scope = {
  logger: Logger;
  request_id?: CorrelationId;
  refresh_id?: CorrelationId;
  active: Map<CorrelationId, Span>;
  closed: boolean;
  refreshes: Set<RefreshTrace>;
};

function scopeFor(logger: Logger): Scope {
  return { logger, active: new Map(), closed: false, refreshes: new Set() };
}
const context = new AsyncLocalStorage<{ scope: Scope; parent?: Span }>();

function end(scope: Scope, span: Span, outcome: Outcome, code?: ErrorCode) {
  if (!scope.active.delete(span.stage_id)) return;
  scope.logger.emit({
    event: "stage.end",
    request_id: scope.request_id,
    refresh_id: span.refresh_id ?? scope.refresh_id,
    stage: span.stage,
    stage_id: span.stage_id,
    parent_stage_id: span.parent_stage_id,
    outcome,
    duration_ms: Math.max(0, performance.now() - span.started),
    code,
  });
}

export async function stage<T>(
  name: Stage,
  operation: () => T | Promise<T>,
): Promise<T> {
  const store = context.getStore();
  if (!store || store.scope.closed || store.scope.active.size >= 8)
    return operation();
  const { scope, parent } = store;
  const span: Span = {
    stage: name,
    stage_id: new CorrelationId(),
    started: performance.now(),
    ...(parent ? { parent_stage_id: parent.stage_id } : {}),
  };
  scope.active.set(span.stage_id, span);
  scope.logger.emit({
    event: "stage.start",
    request_id: scope.request_id,
    refresh_id: scope.refresh_id,
    stage: name,
    stage_id: span.stage_id,
    parent_stage_id: span.parent_stage_id,
  });
  return context.run({ scope, parent: span }, async () => {
    try {
      const result = await operation();
      end(scope, span, "ok");
      return result;
    } catch (error) {
      end(scope, span, "error", safeError(error).code);
      throw error;
    }
  });
}

export class RefreshTrace {
  readonly id = new CorrelationId();
  private scope: Scope;
  constructor(logger: Logger) {
    this.scope = { ...scopeFor(logger), refresh_id: this.id };
  }
  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    return context.run({ scope: this.scope }, async () => {
      try {
        return await stage("auth.refresh", operation);
      } finally {
        this.scope.closed = true;
        this.scope.active.clear();
      }
    });
  }
}

export function createRefresh(): RefreshTrace | undefined {
  const store = context.getStore();
  if (store && !store.scope.closed) return new RefreshTrace(store.scope.logger);
}

export function linkRefresh(refresh: RefreshTrace | undefined): () => void {
  const store = context.getStore();
  if (
    !refresh ||
    !store ||
    store.scope.closed ||
    store.scope.refreshes.size >= 1
  )
    return () => {};
  store.scope.refreshes.add(refresh);
  if (store.parent) store.parent.refresh_id = refresh.id;
  return () => {
    store.scope.refreshes.delete(refresh);
  };
}

export async function withRequest(
  logger: Logger | undefined,
  tool: ToolName,
  limit: number,
  operation: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (!logger) return operation();
  const request_id = new CorrelationId();
  const scope: Scope = { ...scopeFor(logger), request_id };
  const started = performance.now();
  return context.run({ scope }, async () => {
    const base = () => ({
      event: "request.end" as const,
      request_id,
      tool,
      limit,
      duration_ms: Math.max(0, performance.now() - started),
    });
    try {
      const result = await operation();
      logger.emit({
        ...base(),
        outcome: "ok",
        returned_count: Array.isArray(result.items) ? result.items.length : 0,
      });
      return result;
    } catch (error) {
      const code = safeError(error).code;
      logger.emit({
        ...base(),
        outcome: code === "TIMEOUT" ? "timeout" : "error",
        code,
      });
      throw error;
    } finally {
      scope.closed = true;
      scope.active.clear();
      scope.refreshes.clear();
    }
  });
}
