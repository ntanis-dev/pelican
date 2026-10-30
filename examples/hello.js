export const meta = {
  name: "hello",
  description:
    "Two read-only agents look at the folder side by side; a third sums up what they found",
  whenToUse:
    "A first run, to see the workflow runner work. args: { topic?: string } (default: the folder the run works in).",
  phases: [
    { title: "Look", detail: "two read-only agents in parallel" },
    { title: "Sum up", detail: "one agent combines their answers" },
  ],
};

// pelican run examples/hello.js --as lead --wait
const topic =
  typeof args?.topic === "string" ? args.topic : "the current folder";
const LAYOUT = {
  type: "object",
  properties: { entries: { type: "array", items: { type: "string" } } },
  required: ["entries"],
};

phase("Look");
const [layout, purpose] = await parallel([
  () =>
    agent(
      `List the top-level files and folders of ${topic}. Do not edit anything. Return them as entries.`,
      { label: "layout", schema: LAYOUT, resources: [], effort: "low" },
    ),
  () =>
    agent(
      `In two sentences, say what ${topic} is for (read its README if it has one). Do not edit anything; put the two sentences in your report.`,
      { label: "purpose", resources: [], effort: "low" },
    ),
]);
if (!layout || !purpose)
  log("An agent did not finish; summing up what there is.");

phase("Sum up");
const intro = await agent(
  [
    `Write a three-line introduction to ${topic} for a new contributor and put it in your report. Do not edit anything.`,
    layout ? `Its top level: ${layout.entries.join(", ")}.` : "",
    purpose ? `What it is for: ${purpose.report || purpose.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n"),
  { label: "sum-up", resources: [], effort: "low" },
);
return {
  entries: layout?.entries ?? [],
  purpose: purpose ? purpose.report || purpose.summary : null,
  introduction: intro ? intro.report || intro.summary : null,
};
