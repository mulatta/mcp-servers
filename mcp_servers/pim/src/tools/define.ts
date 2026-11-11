import type { z } from "zod";
import type { WriteGroup } from "../config.ts";
import type { Attempt, Jmap } from "../jmap/client.ts";

export interface ToolContext {
  jmap: Jmap;
  signal: AbortSignal;
  /** Set for write tools; marks whether the change left this process. */
  attempt: Attempt;
}

export interface Tool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: `pim_${string}`;
  /** Write group that enables the tool; reads have none. */
  group?: WriteGroup;
  description: string;
  input: Shape;
  /** Cross-field rule the schema alone cannot express. */
  check?: (input: z.infer<z.ZodObject<Shape>>) => boolean;
  destructive?: boolean;
  idempotent?: boolean;
  run: (
    input: z.infer<z.ZodObject<Shape>>,
    context: ToolContext,
  ) => Promise<Record<string, unknown>>;
}

/** Keeps each tool's input type tied to its own schema. */
export function tool<Shape extends z.ZodRawShape>(
  definition: Tool<Shape>,
): Tool {
  return definition as unknown as Tool;
}
