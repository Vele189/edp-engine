/** The subset of an Excalidraw element that reconciliation relies on. */
export interface SceneElement {
  id: string;
  version: number;
  versionNonce?: number;
  isDeleted?: boolean;
  type?: string;
  text?: string;
  x?: number;
  y?: number;
  [k: string]: unknown;
}

/**
 * Excalidraw's own reconciliation rule: per element id the higher `version` wins
 * (ties broken by the lower versionNonce), so concurrent edits from the browser and
 * from Claude both survive, and deletions (which bump the version) stick.
 * Shared by the server and the open board so both merge identically.
 */
export function mergeElements<T extends SceneElement>(current: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map(current.map((e) => [e.id, e]));
  for (const e of incoming) {
    const have = byId.get(e.id);
    if (!have || e.version > have.version || (e.version === have.version && (e.versionNonce ?? 0) < (have.versionNonce ?? 0))) {
      byId.set(e.id, e);
    }
  }
  // Keep the incoming order (z-order) and append anything only the other side knew about.
  const order = [...incoming.map((e) => e.id), ...current.map((e) => e.id)];
  return [...new Set(order)].map((id) => byId.get(id)!);
}
