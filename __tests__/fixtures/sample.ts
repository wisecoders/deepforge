/**
 * A simple event system for demonstration.
 */

export interface EventHandler<T = unknown> {
  handle(event: T): void;
}

export interface Disposable {
  dispose(): void;
}

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

export type EventCallback<T> = (event: T) => void;

/** Base class for all event emitters. */
export abstract class BaseEmitter implements Disposable {
  private listeners: Map<string, Function[]> = new Map();

  abstract getName(): string;

  protected emit(event: string, data: unknown): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((fn) => fn(data));
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class TypedEmitter<T> extends BaseEmitter implements EventHandler<T> {
  private level: LogLevel = LogLevel.Info;

  getName(): string {
    return "TypedEmitter";
  }

  handle(event: T): void {
    this.emit("event", event);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

export const DEFAULT_TIMEOUT = 5000;

export const createEmitter = <T>(): TypedEmitter<T> => {
  return new TypedEmitter<T>();
};

export async function waitForEvent<T>(
  emitter: BaseEmitter,
  event: string,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeout);
  });
}

import { readFileSync } from "fs";

function loadConfig(path: string): Record<string, unknown> {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content);
}
