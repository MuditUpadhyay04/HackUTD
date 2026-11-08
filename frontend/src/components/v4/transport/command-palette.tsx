"use client";
// Command palette (Cmd/Ctrl+K). Opened from the keyboard, so it appears instantly: no animation.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { filterCommands, type Command } from "@/lib/v4/keyboard-commands";

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => { prior?.focus?.(); };
  }, []);
  useEffect(() => { list.current?.children[active]?.scrollIntoView({ block: "nearest" }); }, [active]);

  const run = (c: Command | undefined) => { if (!c) return; onClose(); c.run(); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(shown[active]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "Tab") e.preventDefault();
  };

  return (
    <div className="cp-back" data-kbd="off" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cp" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          className="cp-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="v4-cp-list"
          aria-activedescendant={shown[active] ? `v4-cp-${shown[active].id}` : undefined}
          placeholder="Type a command"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onKey}
          autoComplete="off"
          spellCheck={false}
        />
        {shown.length === 0 ? <div className="cp-empty label">No matching command</div> : (
          <ul className="cp-list" id="v4-cp-list" role="listbox" ref={list}>
            {shown.map((c, i) => (
              <li key={c.id} id={`v4-cp-${c.id}`} role="option" aria-selected={i === active} className="cp-item" onPointerMove={() => setActive(i)} onClick={() => run(c)}>
                <span>{c.label}</span>
                <span className="label">{c.hint ?? c.group}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
