export type ReducerSource =
  | "tool"
  | "command"
  | "scheduler"
  | "eventbus"
  | "monitor"
  | "session"
  | "coordinator"
  | "system";

export type ReducerEntityType = "loop" | "monitor" | "notification";

export interface ReducerEvent<TType extends string = string, TPayload = unknown> {
  type: TType;
  at: number;
  source: ReducerSource;
  entityType?: ReducerEntityType;
  entityId?: string;
  payload: TPayload;
}

export interface ReducerEffect<TEffect extends string = string, TPayload = unknown> {
  type: TEffect;
  entityType?: ReducerEntityType;
  entityId?: string;
  payload: TPayload;
}

export type DispatchEventEffect = ReducerEffect<"DISPATCH_EVENT", { event: ReducerEvent }>;
export type AnyReducerEffect = ReducerEffect | DispatchEventEffect;

export type ReducerHandler =
  (event: ReducerEvent) => undefined | AnyReducerEffect[] | Promise<undefined | AnyReducerEffect[]>;

export type EffectHandler<TResult = void> =
  (effect: ReducerEffect) => TResult | undefined | Promise<TResult | undefined>;

export interface CoordinatorOptions<TResult = void> {
  reducers: ReducerHandler[];
  effectHandlers?: Partial<Record<string, EffectHandler<TResult>>>;
  effectExecutor?: EffectHandler<TResult>;
  maxDispatchDepth?: number;
}

export class CoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorError";
  }
}

export interface Coordinator<TResult = void> {
  dispatch(event: ReducerEvent): Promise<TResult[]>;
}

export function createCoordinator<TResult = void>(options: CoordinatorOptions<TResult>): Coordinator<TResult> {
  const {
    reducers,
    effectHandlers = {},
    effectExecutor,
    maxDispatchDepth = 100,
  } = options;

  function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return typeof value === "object" && value !== null && "then" in value;
  }

  async function executeEffect(effect: AnyReducerEffect, depth: number): Promise<TResult[]> {
    if (effect.type === "DISPATCH_EVENT") {
      const dispatchEffect = effect as DispatchEventEffect;
      const derivedEvent = dispatchEffect.payload.event;
      if (!derivedEvent) {
        throw new CoordinatorError("DISPATCH_EVENT effect missing payload.event");
      }
      return dispatchAtDepth(derivedEvent, depth + 1);
    }

    const specificHandler = effectHandlers[effect.type];
    if (specificHandler) {
      const handled = specificHandler(effect);
      const result = isPromiseLike(handled) ? await handled : handled;
      return result === undefined ? [] : [result];
    }

    if (effectExecutor) {
      const handled = effectExecutor(effect);
      const result = isPromiseLike(handled) ? await handled : handled;
      return result === undefined ? [] : [result];
    }
    return [];
  }

  async function dispatchAtDepth(event: ReducerEvent, depth: number): Promise<TResult[]> {
    if (depth > maxDispatchDepth) {
      throw new CoordinatorError(`Maximum dispatch depth exceeded (${maxDispatchDepth})`);
    }

    const effects: AnyReducerEffect[] = [];
    for (const reducer of reducers) {
      const emitted = reducer(event);
      const resolved = isPromiseLike(emitted) ? await emitted : emitted;
      if (!resolved || resolved.length === 0) continue;
      effects.push(...resolved);
    }

    const results: TResult[] = [];
    for (const effect of effects) {
      results.push(...await executeEffect(effect, depth));
    }
    return results;
  }

  return {
    dispatch(event: ReducerEvent): Promise<TResult[]> {
      return dispatchAtDepth(event, 1);
    },
  };
}
