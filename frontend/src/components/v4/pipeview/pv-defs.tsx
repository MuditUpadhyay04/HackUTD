// Shared SVG defs for the Pipe View: dot grid, dissolve masks, tank capsule clip, dither strokes, hatches.
// Patterns marked data-grain are counter-scaled by the camera (see pipe-view.tsx) so grain stays constant on screen.
import { memo } from "react";
import { bayerCells, GRAIN_BY_Q } from "@/lib/v4/pipeview-dither";

const cells = (lit: number, cell: number, fill: string | undefined, style?: React.CSSProperties) =>
  bayerCells(lit).map(([x, y]) => <rect key={`${x}${y}`} x={x * cell} y={y * cell} width={cell} height={cell} fill={fill} style={style} shapeRendering="crispEdges" />);

const BIG = 40000;

function Defs({ uid }: { uid: string }) {
  return (
    <defs>
      <pattern id={`${uid}-dots`} patternUnits="userSpaceOnUse" width={28} height={28}>
        <circle cx={1} cy={1} r={1} style={{ fill: "var(--grid-dot, rgba(255,240,225,0.07))" }} />
      </pattern>
      {[0.25, 0.5, 0.75].map((lit, i) => (
        <g key={lit}>
          <pattern id={`${uid}-dmp${i + 1}`} data-grain="mask" patternUnits="userSpaceOnUse" width={8} height={8}>{cells(lit, 2, "#fff")}</pattern>
          <mask id={`${uid}-dm${i + 1}`} maskUnits="userSpaceOnUse" x={-BIG / 2} y={-BIG / 2} width={BIG} height={BIG}>
            <rect x={-BIG / 2} y={-BIG / 2} width={BIG} height={BIG} fill={`url(#${uid}-dmp${i + 1})`} />
          </mask>
        </g>
      ))}
      <clipPath id={`${uid}-cap`}><rect x={-6} y={-10} width={12} height={20} rx={6} /></clipPath>
      {Array.from({ length: 8 }, (_, c) => [1, 2, 3].map((s) => (
        <pattern key={`${c}-${s}`} id={`${uid}-d-${c + 1}-${s}`} data-grain="dither" patternUnits="userSpaceOnUse" width={8} height={8}>
          {cells(1 - GRAIN_BY_Q[s as 1 | 2 | 3], 2, undefined, { fill: `var(--n${c + 1})`, fillOpacity: 0.75 })}
        </pattern>
      )))}
      <pattern id={`${uid}-hatchw`} data-grain="hatch" patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
        <rect width={1.6} height={6} rx={0.8} style={{ fill: "var(--magenta)", fillOpacity: 0.85 }} />
      </pattern>
      <pattern id={`${uid}-hatchpx`} patternUnits="userSpaceOnUse" width={5} height={5} patternTransform="rotate(45)">
        <rect width={1.5} height={5} rx={0.75} style={{ fill: "var(--magenta)", fillOpacity: 0.85 }} />
      </pattern>
    </defs>
  );
}
export const PvDefs = memo(Defs);
