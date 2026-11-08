import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeft } from "lucide-react";
import { NemotronMark } from "@/components/console/nemotron";

const steps = [
  ["Sensor readings", "Tank level, pump status and flow, pipeline pressure and every well, every five minutes."],
  ["Detection", "Finds pump failures, leaks and worn pumps from the readings alone, with a confidence and the evidence."],
  ["Plan solver", "Costs every option: trucks, shutting in wells early, or doing nothing, and splits a system's shared trucks between failing tanks. Deterministic: the same readings always give the same costs."],
  ["Nemotron handoff", "Rewrites the solver's facts into a short note for the next operator. It adds no numbers of its own. Until an NVIDIA endpoint is connected, the console shows the solver's own draft."],
  ["This console", "What is failing, how long until it shuts in, and the cheapest way to keep running."],
] as const;

// Planned work, not running yet. Today the plan solver does all of this deterministically
// and one Nemotron call writes the handoff note.
const agents = [
  ["Orchestrator", "Would read each new problem, decide which specialists to call, and merge their answers into one plan."],
  ["Fleet planner", "Would call the solver as a tool to compare truck splits and explain the choice. Today the solver splits the trucks itself."],
  ["Well economist", "Would explain which wells to shut in and when, using the solver's dollars lost per barrel of water avoided."],
  ["Inspection agent", "Would draft inspection tickets from leak and worn-pump alerts, with the readings as evidence."],
  ["Shift handoff", "Would track what was done and what is due across shifts. Today a single Nemotron call writes the note from the solver's facts."],
] as const;

export const metadata: Metadata = { title: "How it works" };

const backClass = "inline-flex items-center gap-1.5 text-[14px] text-muted-foreground hover:text-text";
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// Carry the console's dataset (and replay time, if any) back so the round trip lands where it started.
async function BackLink({ searchParams }: { searchParams: PageProps<"/how-it-works">["searchParams"] }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  const dataset = one(sp.dataset);
  const at = one(sp.at);
  if (dataset) q.set("dataset", dataset);
  if (at) q.set("at", at);
  return <BackAnchor href={q.size ? `/?${q.toString()}` : "/"} />;
}

function BackAnchor({ href }: { href: string }) {
  return (
    <Link href={href} className={backClass}>
      <ArrowLeft className="size-4" aria-hidden /> Console
    </Link>
  );
}

export default function HowItWorks({ searchParams }: PageProps<"/how-it-works">) {
  return (
    <main className="mx-auto max-w-[880px] px-5 pt-8 pb-24 sm:px-8">
      <Suspense fallback={<BackAnchor href="/" />}>
        <BackLink searchParams={searchParams} />
      </Suspense>

      <h1 className="mt-10 max-w-[26ch] text-balance text-[clamp(30px,4.6vw,46px)] leading-[1.1] font-display font-bold tracking-display text-text">
        A pump fails at 2 a.m. The console has a costed plan before anyone picks up a radio.
      </h1>
      <p className="mt-5 flex max-w-[60ch] items-start gap-2.5 text-[16px] leading-relaxed text-muted-foreground">
        <NemotronMark className="mt-1 size-5 shrink-0" />
        <span>
          A deterministic detector and plan solver compute every number on the console, including how a system&apos;s
          shared trucks are split. <span className="font-medium text-text">NVIDIA Nemotron</span> writes the shift
          handoff from the solver&apos;s facts. No cost or countdown on the console comes from a language model.
        </span>
      </p>

      <h2 className="mt-16 font-display text-[20px] font-bold tracking-display text-text">From a reading to a decision</h2>
      <ol className="mt-4 border-t border-line">
        {steps.map(([name, body], i) => (
          <li key={name} className="grid grid-cols-[28px_1fr] gap-x-3 border-b border-line py-4 sm:grid-cols-[28px_200px_1fr]">
            <span className="num pt-px text-[14px] text-faint">{i + 1}</span>
            <span className="text-[15px] font-medium text-text">{name}</span>
            <span className="col-start-2 text-[15px] leading-relaxed text-muted-foreground sm:col-start-3">{body}</span>
          </li>
        ))}
      </ol>

      <h2 className="mt-14 font-display text-[20px] font-bold tracking-display text-text">Planned agents</h2>
      <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-muted-foreground">
        Not running yet. The steps under the shift note use these names, but the plan solver writes them.
      </p>
      <dl className="mt-4 border-t border-line">
        {agents.map(([name, body]) => (
          <div key={name} className="grid grid-cols-1 gap-x-3 border-b border-line py-4 sm:grid-cols-[228px_1fr]">
            <dt className="flex items-center gap-2 text-[15px] font-medium text-text">
              {name}
              <span className="rounded border border-line px-1.5 py-px text-[12px] font-normal text-faint">Planned</span>
            </dt>
            <dd className="text-[15px] leading-relaxed text-muted-foreground">{body}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
