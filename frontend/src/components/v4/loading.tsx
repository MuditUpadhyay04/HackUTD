// Server-renderable loading state (Suspense fallback) in v4 style.
export function V4Loading({ message = "Reading the network" }: { message?: string }) {
  return (
    <div className="v4" role="status">
      <div className="v4-center">
        <div className="label">Pipe View</div>
        <div className="v4-loadbar" aria-hidden />
        <div style={{ fontSize: "var(--fs-2)", color: "var(--muted)" }}>{message}</div>
      </div>
    </div>
  );
}
