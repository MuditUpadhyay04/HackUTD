// Command palette model (pure). The Transport builds the list; this file filters it.
export interface Command {
  id: string;
  /** Short uppercase group tag shown at the right of the row. */
  group: string;
  label: string;
  /** Optional key hint, e.g. "M". */
  hint?: string;
  run(): void;
}

/** Every whitespace separated token must appear in group + label (case-insensitive). Empty query keeps the order. */
export function filterCommands<T extends Pick<Command, "label" | "group">>(commands: readonly T[], query: string): T[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...commands];
  return commands.filter((c) => {
    const hay = `${c.group} ${c.label}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}
