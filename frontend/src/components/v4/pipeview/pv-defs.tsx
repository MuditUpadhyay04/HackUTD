// Shared SVG defs for the Pipe View: dot grid, dissolve masks, gauge mask, dither strokes, hatches.
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
        <circle cx={1} cy={1} r={1} fill="rgba(255,238,214,0.22)" />
      </pattern>
      {[0.25, 0.5, 0.75].map((lit, i) => (
        <g key={lit}>
          <pattern id={`${uid}-dmp${i + 1}`} data-grain="mask" patternUnits="userSpaceOnUse" width={8} height={8}>{cells(lit, 2, "#fff")}</pattern>
          <mask id={`${uid}-dm${i + 1}`} maskUnits="userSpaceOnUse" x={-BIG / 2} y={-BIG / 2} width={BIG} height={BIG}>
            <rect x={-BIG / 2} y={-BIG / 2} width={BIG} height={BIG} fill={`url(#${uid}-dmp${i + 1})`} />
          </mask>
        </g>
      ))}
      <pattern id={`${uid}-gp`} patternUnits="userSpaceOnUse" width={4} height={4}>{cells(0.55, 1, "#fff")}</pattern>
      <mask id={`${uid}-gauge`} maskUnits="userSpaceOnUse" x={-10} y={-12} width={20} height={24}>
        <rect x={-10} y={-12} width={20} height={24} fill={`url(#${uid}-gp)`} />
      </mask>
      {Array.from({ length: 8 }, (_, c) => [1, 2, 3].map((s) => (
        <pattern key={`${c}-${s}`} id={`${uid}-d-${c + 1}-${s}`} data-grain="dither" patternUnits="userSpaceOnUse" width={8} height={8}>
          {cells(1 - GRAIN_BY_Q[s as 1 | 2 | 3], 2, undefined, { fill: `var(--n${c + 1})` })}
        </pattern>
      )))}
      <pattern id={`${uid}-hatchw`} data-grain="hatch" patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
        <rect width={1.6} height={6} style={{ fill: "var(--magenta)" }} />
      </pattern>
      <pattern id={`${uid}-hatchpx`} patternUnits="userSpaceOnUse" width={5} height={5} patternTransform="rotate(45)">
        <rect width={1.5} height={5} style={{ fill: "var(--magenta)" }} />
      </pattern>
    </defs>
  );
}
export const PvDefs = memo(Defs);
